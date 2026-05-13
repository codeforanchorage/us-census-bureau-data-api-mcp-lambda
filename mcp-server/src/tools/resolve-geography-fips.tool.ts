import { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import { DatabaseService } from '../services/database.service.js'
import {
  ResolveGeographyFipsArgs,
  ResolveGeographyFipsArgsSchema,
  ResolveGeographyFipsInputSchema,
} from '../schema/resolve-geography-fips.schema.js'

import { GeographySearchResultRow } from '../types/geography.types.js'
import { SummaryLevelRow } from '../types/summary-level.types.js'
import { ToolContent } from '../types/base.types.js'

export const toolDescription = `Call this to convert any place name into Census FIPS codes; never guess FIPS digits from memory. Accepts a natural-language geography_name (e.g. "Philadelphia", "Cook County") and an optional summary_level filter. Returns FIPS codes and ready-to-use for/in query strings for fetch-aggregate-data, plus available vintages and parent-geography hierarchy.`
export class ResolveGeographyFipsTool extends BaseTool<ResolveGeographyFipsArgs> {
  name = 'resolve-geography-fips'
  description = toolDescription
  readonly requiresApiKey = false

  private dbService: DatabaseService

  inputSchema: Tool['inputSchema'] =
    ResolveGeographyFipsArgsSchema as Tool['inputSchema']

  get argsSchema() {
    return ResolveGeographyFipsInputSchema
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
    this.dbService = DatabaseService.getInstance()
  }

  private async searchGeographiesBySummaryLevel(
    query: string,
    summary_level_code: string,
  ): Promise<GeographySearchResultRow[]> {
    const result = await this.dbService.query<GeographySearchResultRow>(
      `SELECT * FROM search_geographies_by_summary_level($1, $2)`,
      [query, summary_level_code],
    )

    return result.rows
  }

  private async searchGeographies(
    query: string,
  ): Promise<GeographySearchResultRow[]> {
    const result = await this.dbService.query<GeographySearchResultRow>(
      `SELECT * FROM search_geographies($1)`,
      [query],
    )

    return result.rows
  }

  private async searchSummaryLevels(query: string): Promise<SummaryLevelRow[]> {
    const result = await this.dbService.query<SummaryLevelRow>(
      `SELECT * FROM search_summary_levels($1)`,
      [query],
    )

    return result.rows
  }

  async toolHandler(
    args: ResolveGeographyFipsArgs,
  ): Promise<{ content: ToolContent[] }> {
    try {
      // Check database health first
      const isDbHealthy = await this.dbService.healthCheck()
      if (!isDbHealthy) {
        return this.createErrorResponse(
          'Database connection failed; cannot retrieve geography metadata. Retry once the local mcp-db container is up.',
        )
      }

      let result: GeographySearchResultRow[]
      let summaryLevelResolved: string | null = null

      if (args.summary_level) {
        const summary_levels = await this.searchSummaryLevels(
          args.summary_level,
        )

        if (summary_levels.length > 0) {
          summaryLevelResolved = summary_levels[0].name
          result = await this.searchGeographiesBySummaryLevel(
            args.geography_name,
            summary_levels[0].code,
          )
        } else {
          result = await this.searchGeographies(args.geography_name)
        }
      } else {
        result = await this.searchGeographies(args.geography_name)
      }

      if (!result || result.length === 0) {
        return this.createSuccessResponse(
          [
            `## Result`,
            `No geographies matched "${args.geography_name}"${
              args.summary_level ? ` at summary level "${args.summary_level}"` : ''
            }.`,
            ``,
            `Retry with a broader geography_name (drop modifiers like "city" or "County"), or omit summary_level entirely. If the spelling is uncertain, search the canonical Census place name in list-datasets or fetch-dataset-geography output first.`,
          ].join('\n'),
        )
      }

      const limit = args.limit ?? 25
      const truncated = result.length > limit
      const visible = truncated ? result.slice(0, limit) : result

      return this.createSuccessResponse(
        formatGeographyResults({
          query: args.geography_name,
          summaryLevelRequested: args.summary_level ?? null,
          summaryLevelResolved,
          totalMatches: result.length,
          visible,
          truncated,
        }),
      )
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred'

      return this.createErrorResponse(
        `Failed to resolve geography: ${errorMessage}. Retry after confirming the local mcp-db service is reachable.`,
      )
    }
  }
}

// Render geographies as numbered Record blocks rather than a JSON dump so the
// shape survives Copilot's renderer. The `for` and `in` query params are the
// load-bearing fields downstream callers need, so they go first.
function formatGeographyResults(opts: {
  query: string
  summaryLevelRequested: string | null
  summaryLevelResolved: string | null
  totalMatches: number
  visible: GeographySearchResultRow[]
  truncated: boolean
}): string {
  const sections: string[] = []

  if (opts.truncated) {
    sections.push(
      `## Caveats`,
      `**TRUNCATED:** matched ${opts.totalMatches} geographies; showing the top ${opts.visible.length}. Narrow geography_name or pass summary_level to filter further.`,
    )
  }

  sections.push(`## Query`)
  const queryLines: string[] = [`geography_name: ${opts.query}`]
  if (opts.summaryLevelRequested) {
    queryLines.push(
      `summary_level (requested): ${opts.summaryLevelRequested}` +
        (opts.summaryLevelResolved
          ? ` (resolved to: ${opts.summaryLevelResolved})`
          : ' (no matching summary level; ignored)'),
    )
  }
  sections.push(queryLines.join('\n'))

  sections.push(`## Records`)
  const records = opts.visible.map((row, i) => {
    const lines: string[] = []
    lines.push(`Record ${i + 1}:`)
    lines.push(`  name: ${row.name}`)
    lines.push(`  summary_level: ${row.summary_level_name}`)
    lines.push(`  for: ${row.for_param}`)
    if (row.in_param) lines.push(`  in: ${row.in_param}`)
    if (typeof row.latitude === 'number' && typeof row.longitude === 'number') {
      lines.push(`  centroid: ${row.latitude}, ${row.longitude}`)
    }
    return lines.join('\n')
  })
  sections.push(records.join('\n\n'))

  if (opts.truncated) {
    sections.push(
      `(Reminder: ${opts.totalMatches} geographies matched; only ${opts.visible.length} are shown above. Disambiguate before forwarding to fetch-aggregate-data.)`,
    )
  }

  return sections.join('\n\n')
}
