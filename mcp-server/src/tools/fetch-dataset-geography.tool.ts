import { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import { DatabaseService } from '../services/database.service.js'
import { fetchWithTimeout } from '../helpers/http.js'
import {
  FetchDatasetGeographyArgs,
  FetchDatasetGeographyArgsSchema,
  FetchDatasetGeographyInputSchema,
  FetchDatasetGeographyOutputSchema,
  GeographyJsonSchema,
} from '../schema/dataset-geography.schema.js'
import { ToolCaveat, ToolResponse } from '../types/base.types.js'
import {
  SummaryLevelRow,
  GeographyMetadata,
  ParsedGeographyEntry,
} from '../types/summary-level.types.js'

export const toolDescription = `Call this BEFORE fetch-aggregate-data to confirm which geographic levels the dataset supports; do not assume tract or block-group data is available (a 1-year ACS does not publish tract data). Returns, per level, the for=/in= query syntax and an example, the 3-digit summary level code, the parent geographies it requires in in=, whether wildcards are allowed, and its hierarchy.`

export class FetchDatasetGeographyTool extends BaseTool<FetchDatasetGeographyArgs> {
  name = 'fetch-dataset-geography'
  title = 'Fetch Dataset Geography'
  description = toolDescription
  readonly requiresApiKey = true

  private dbService: DatabaseService

  inputSchema: Tool['inputSchema'] =
    FetchDatasetGeographyArgsSchema as Tool['inputSchema']
  outputSchema: Tool['inputSchema'] =
    FetchDatasetGeographyOutputSchema as Tool['inputSchema']

  get argsSchema() {
    return FetchDatasetGeographyInputSchema
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
    this.dbService = DatabaseService.getInstance()
  }

  private async getSummaryLevels(): Promise<SummaryLevelRow[]> {
    const result = await this.dbService.query<SummaryLevelRow>(`
      SELECT 
        id,
        name,
        description,
        get_variable,
        query_name,
        on_spine,
        code,
        parent_summary_level,
        parent_summary_level_id
      FROM summary_levels
      ORDER BY code
    `)

    return result.rows
  }

  private buildGeographyMetadata(levels: SummaryLevelRow[]): GeographyMetadata {
    const metadata: GeographyMetadata = {}

    for (const level of levels) {
      // Generate query example based on hierarchy
      let queryExample: string
      if (level.parent_summary_level) {
        // Find parent level to build hierarchical query
        const parentLevel = levels.find(
          (l) => l.code === level.parent_summary_level,
        )
        if (parentLevel) {
          // Special case: Don't use US as a parent in queries
          if (parentLevel.code === '010') {
            // For geographies that have US as parent, just use standalone syntax
            queryExample = `for=${level.query_name}:*`
          } else {
            // Normal hierarchical query
            queryExample = `for=${level.query_name}:*&in=${parentLevel.query_name}:*`
          }
        } else {
          queryExample = `for=${level.query_name}:*`
        }
      } else {
        // No parent - standalone query
        queryExample = `for=${level.query_name}:*`
      }

      metadata[level.name] = {
        querySyntax: level.query_name,
        code: level.code,
        queryExample: queryExample,
        onSpine: level.on_spine,
      }
    }

    return metadata
  }

  // Override the parseGeographyJson function to use database data
  private parseGeographyJsonWithDb(
    rawGeography: unknown,
    geographyLevels: SummaryLevelRow[],
  ): ParsedGeographyEntry[] {
    const validatedRaw = GeographyJsonSchema.parse(rawGeography)

    if (validatedRaw.fips.length === 0) {
      console.log('No FIPS geography data found in response')
      return []
    }

    // Build metadata from database
    const geographyMetadata = this.buildGeographyMetadata(geographyLevels)

    // Create reverse lookup by summary level code
    const codeToLevel = new Map<string, SummaryLevelRow>()
    geographyLevels.forEach((level) => {
      codeToLevel.set(level.code, level)
    })

    const parsed = validatedRaw.fips.map((entry) => {
      const dbLevel = codeToLevel.get(entry.geoLevelDisplay)
      const metadata = dbLevel ? geographyMetadata[dbLevel.name] : null

      // Use database data if available, fallback to simple replacement
      const displayName =
        dbLevel?.name || this.getDisplayNameFromApiName(entry.name)
      const querySyntax = dbLevel?.query_name || entry.name.replace(/\s+/g, '+')
      const queryExample =
        metadata?.queryExample ||
        this.generateFallbackQueryExample(entry.name, entry.requires)

      return {
        vintage: entry.referenceDate,
        displayName: displayName,
        querySyntax: querySyntax,
        code: entry.geoLevelDisplay,
        name: entry.name,
        hierarchy: entry.requires
          ? [...entry.requires, entry.name]
          : [entry.name],
        fullName: displayName,
        description: dbLevel?.description || undefined,
        onSpine: metadata?.onSpine ?? false,
        queryExample: queryExample,
        requires: entry.requires,
        allowsWildcard: Boolean(entry.wildcard && entry.wildcard.length > 0),
        wildcardFor: entry.optionalWithWCFor
          ? [entry.optionalWithWCFor]
          : undefined,
      }
    })

    return parsed
  }

  // Simple fallback for query example generation (only used if database record not found)
  private generateFallbackQueryExample(
    name: string,
    requires?: string[],
  ): string {
    const querySyntax = name.replace(/\s+/g, '+')

    if (!requires || requires.length === 0) {
      return `for=${querySyntax}:*`
    }

    const parentSyntax = requires
      .map((req) => req.replace(/\s+/g, '+'))
      .join(':*&in=')
    return `for=${querySyntax}:*&in=${parentSyntax}:*`
  }

  private getDisplayNameFromApiName(apiName: string): string {
    return apiName
      .split(/[\s]+/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
  }

  async toolHandler(
    args: FetchDatasetGeographyArgs,
    apiKey: string,
  ): Promise<ToolResponse> {
    try {
      // Get geography levels from database
      const geographyLevels = await this.getSummaryLevels()

      let year = ''
      if (args.year) {
        year = `${args.year}/`
      }

      const baseUrl = `https://api.census.gov/data/${year}${args.dataset}/geography.json`
      const geographyUrl = `${baseUrl}?key=${apiKey}`

      const geographyResponse = await fetchWithTimeout(geographyUrl)

      if (geographyResponse.ok) {
        const geographyData = await geographyResponse.json()

        try {
          const validatedData = GeographyJsonSchema.parse(geographyData)
          // Use the database-aware parsing function
          const parsedGeographyData = this.parseGeographyJsonWithDb(
            validatedData,
            geographyLevels,
          )

          // An empty fips list is still a successful, schema-conforming
          // result: structuredContent must be present with total_count 0.
          const caveats: ToolCaveat[] =
            parsedGeographyData.length === 0
              ? [
                  {
                    code: 'NO_GEOGRAPHY_LEVELS',
                    message: `${args.dataset} publishes no FIPS geography levels${args.year ? ` for ${args.year}` : ''} -- it cannot be queried by for=/in= geography.`,
                  },
                ]
              : []

          const caveatText =
            caveats.length > 0
              ? `\n\n${caveats.map((c) => `**${c.code}:** ${c.message}`).join('\n\n')}`
              : ''

          return this.createSuccessResponse(
            `Available geographies for ${args.dataset}${args.year ? ` (${args.year})` : ''}:\n\n${JSON.stringify(parsedGeographyData)}${caveatText}`,
            {
              query: { dataset: args.dataset, year: args.year ?? null },
              total_count: parsedGeographyData.length,
              levels: parsedGeographyData,
              caveats,
            },
          )
        } catch (validationError) {
          const validationMessage =
            validationError instanceof Error
              ? validationError.message
              : 'Validation failed'
          console.error('Schema validation failed:', validationMessage)

          return this.createErrorResponse(
            `Response validation failed: ${validationMessage}. The Census Data API may have returned an unexpected payload; retry, and if the failure persists report it as a schema-format issue.`,
          )
        }
      } else {
        console.log(geographyResponse.status)
        const status = geographyResponse.status
        let recovery = ''
        if (status === 404) {
          recovery =
            ' The dataset/year combination was not found; call list-datasets to confirm the dataset exists and which vintages are published.'
        } else {
          recovery =
            ' Retry after a short delay; if the failure persists call list-datasets to confirm the dataset is still published.'
        }
        return this.createErrorResponse(
          `Census geography endpoint returned ${status} ${geographyResponse.statusText}.${recovery}`,
        )
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred'

      // Database and timeout errors already carry retry advice; a raw
      // network error from api.census.gov does not.
      const advice = /retry/i.test(errorMessage)
        ? ''
        : ' Retry after a short delay.'
      return this.createErrorResponse(
        `Failed to fetch dataset geography levels: ${errorMessage}${advice}`,
      )
    }
  }
}
