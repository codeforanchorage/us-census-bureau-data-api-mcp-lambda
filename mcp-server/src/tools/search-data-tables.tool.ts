import { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import { DatabaseService } from '../services/database.service.js'
import {
  SearchDataTablesArgs,
  SearchDataTablesArgsSchema,
  SearchDataTablesInputSchema,
} from '../schema/search-data-tables.schema.js'

import { DataTableSearchResultRow } from '../types/data-table.types.js'
import { ToolContent } from '../types/base.types.js'

export const toolDescription = `Call this BEFORE fetch-aggregate-data to find the right table_id and cell codes; never guess Census cell codes from memory. Searches 32,000+ Census tables by ID prefix, natural-language label, or API endpoint. Pass api_endpoint (e.g. "acs/acs1") whenever the dataset is known to cut cross-survey noise. Returns table_id, label, component, and the dataset/year combinations the table appears in. Coverage is concentrated in ACS; Economic Census, Geography, and PEP have little or no indexed coverage.`

export class SearchDataTablesTool extends BaseTool<SearchDataTablesArgs> {
  name = 'search-data-tables'
  description = toolDescription
  readonly requiresApiKey = false

  private dbService: DatabaseService

  inputSchema: Tool['inputSchema'] =
    SearchDataTablesArgsSchema as unknown as Tool['inputSchema']

  get argsSchema() {
    return SearchDataTablesInputSchema
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
    this.dbService = DatabaseService.getInstance()
  }

  private async searchDataTables(
    args: SearchDataTablesArgs,
  ): Promise<DataTableSearchResultRow[]> {
    const {
      data_table_id = null,
      label_query = null,
      api_endpoint = null,
      limit = 20,
    } = args

    const result = await this.dbService.query<DataTableSearchResultRow>(
      `SELECT * FROM search_data_tables($1, $2, $3, $4)`,
      [data_table_id, label_query, api_endpoint, limit],
    )

    return result.rows
  }

  async toolHandler(
    args: SearchDataTablesArgs,
  ): Promise<{ content: ToolContent[] }> {
    try {
      // Check database health first
      const isDbHealthy = await this.dbService.healthCheck()
      if (!isDbHealthy) {
        return this.createErrorResponse(
          'Database connection failed; cannot search data tables. Retry once the local mcp-db container is up.',
        )
      }

      const results = await this.searchDataTables(args)
      const limit = args.limit ?? 20

      if (!results || results.length === 0) {
        const searchTerms = [
          args.data_table_id && `data_table_id "${args.data_table_id}"`,
          args.label_query && `label_query "${args.label_query}"`,
          args.api_endpoint && `api_endpoint "${args.api_endpoint}"`,
        ]
          .filter(Boolean)
          .join(', ')

        return this.createSuccessResponse(
          [
            `## Result`,
            `No data tables matched ${searchTerms}.`,
            ``,
            `Retry with shorter or Census-canonical wording in label_query (e.g. "poverty" over "low income", "tenure" over "renting"), or relax api_endpoint. If you have a table_id prefix, drop the suffix and search by prefix.`,
          ].join('\n'),
        )
      }

      return this.createSuccessResponse(
        formatDataTableResults({
          args,
          results,
          limit,
        }),
      )
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred'

      return this.createErrorResponse(
        `Failed to search data tables: ${errorMessage}. Retry after a brief delay; if the failure persists, the local mcp-db service may be down.`,
      )
    }
  }
}

// Render results as numbered Record blocks. The data_table_id is the
// load-bearing field downstream callers need, so it goes first; the
// dataset/year combinations follow in a compact line.
function formatDataTableResults(opts: {
  args: SearchDataTablesArgs
  results: DataTableSearchResultRow[]
  limit: number
}): string {
  const { args, results, limit } = opts
  const truncated = results.length >= limit
  const sections: string[] = []

  if (truncated) {
    sections.push(
      `## Caveats`,
      `**TRUNCATED:** returned ${results.length} (the requested limit). More may exist; narrow label_query or pass api_endpoint to filter.`,
    )
  }

  sections.push(`## Query`)
  const queryLines: string[] = []
  if (args.data_table_id) queryLines.push(`data_table_id: ${args.data_table_id}`)
  if (args.label_query) queryLines.push(`label_query: ${args.label_query}`)
  if (args.api_endpoint) queryLines.push(`api_endpoint: ${args.api_endpoint}`)
  queryLines.push(`limit: ${limit}`)
  sections.push(queryLines.join('\n'))

  sections.push(`## Records`)
  const records = results.map((row, i) => {
    const datasetSummary = Object.entries(row.datasets)
      .map(([year, endpoints]) => `${year}: ${endpoints.join(', ')}`)
      .join('; ')
    const lines: string[] = []
    lines.push(`Record ${i + 1}:`)
    lines.push(`  data_table_id: ${row.data_table_id}`)
    lines.push(`  label: ${row.label}`)
    lines.push(`  component: ${row.component}`)
    if (datasetSummary) lines.push(`  datasets: ${datasetSummary}`)
    return lines.join('\n')
  })
  sections.push(records.join('\n\n'))

  if (truncated) {
    sections.push(
      `(Reminder: results above are limited to ${limit}; narrow the query before forwarding to fetch-aggregate-data.)`,
    )
  }

  return sections.join('\n\n')
}
