// Completes the pair upstream PR #141 promised: that PR shipped the
// list_survey_components(TEXT) database function but never the MCP tool
// in front of it, leaving list-survey-programs' acronyms a dead end. The
// tool follows this fork's conventions (title, binding outputSchema +
// structuredContent, caveats with stable codes, Record-block text).
import { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import { DatabaseService } from '../services/database.service.js'
import {
  ListSurveyComponentsArgs,
  ListSurveyComponentsArgsSchema,
  ListSurveyComponentsInputSchema,
  ListSurveyComponentsOutputSchema,
} from '../schema/list-survey-components.schema.js'
import { SurveyComponentRow } from '../types/survey-program.types.js'
import { ToolCaveat, ToolResponse } from '../types/base.types.js'

export const toolDescription = `Call this after list-survey-programs to expand a program acronym (e.g. "ACS") into its concrete components. Each record carries the api_endpoint to pass to search-data-tables (api_endpoint) and to fetch-aggregate-data / fetch-dataset-geography (dataset), plus the published vintage range, release frequency, and indexed-table count. table_count 0 means search-data-tables has nothing indexed for that component, not that the component has no data. has_gaps true means some years inside the vintage range are missing -- verify a specific year via list-datasets before querying it.`

export class ListSurveyComponentsTool extends BaseTool<ListSurveyComponentsArgs> {
  name = 'list-survey-components'
  title = 'List Survey Components'
  description = toolDescription
  readonly requiresApiKey = false

  private dbService: DatabaseService

  inputSchema: Tool['inputSchema'] =
    ListSurveyComponentsArgsSchema as Tool['inputSchema']
  outputSchema: Tool['inputSchema'] =
    ListSurveyComponentsOutputSchema as Tool['inputSchema']

  get argsSchema() {
    return ListSurveyComponentsInputSchema
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
    this.dbService = DatabaseService.getInstance()
  }

  async toolHandler(args: ListSurveyComponentsArgs): Promise<ToolResponse> {
    try {
      // Acronyms are stored uppercase; be forgiving about input case.
      const programString = args.program_string.trim().toUpperCase()

      const result = await this.dbService.query<SurveyComponentRow>(
        `SELECT * FROM list_survey_components($1)`,
        [programString],
      )
      const rows = result.rows

      const caveats: ToolCaveat[] = []
      if (rows.length === 0) {
        caveats.push({
          code: 'NO_MATCH',
          message: `"${programString}" matched no survey program. A miss here means "no program under this acronym", not "the Census lacks this survey" -- call list-survey-programs for the valid acronyms.`,
        })
      }
      const unindexed = rows.filter((r) => r.table_count === 0)
      if (unindexed.length > 0) {
        caveats.push({
          code: 'NO_INDEXED_TABLES',
          message: `${unindexed.length} of ${rows.length} components have no tables indexed in search-data-tables; their data may still be reachable via fetch-aggregate-data with known variable names.`,
        })
      }
      const gapped = rows.filter((r) => r.has_gaps === true)
      if (gapped.length > 0) {
        caveats.push({
          code: 'VINTAGE_GAPS',
          message: `${gapped.length} component(s) have missing years inside their vintage range (has_gaps: true). Verify a specific vintage via list-datasets before querying it.`,
        })
      }

      const sections: string[] = []
      if (caveats.length > 0) {
        sections.push(
          '## Caveats',
          caveats.map((c) => `**${c.code}:** ${c.message}`).join('\n\n'),
        )
      }
      sections.push('## Query')
      sections.push(`program_string: ${programString}`)
      sections.push('## Records')
      sections.push(
        rows.length === 0
          ? '(no components found)'
          : rows
              .map((row, i) => {
                const lines = [`Record ${i + 1}:`]
                lines.push(`  component: ${row.component_label}`)
                lines.push(`  api_endpoint: ${row.api_endpoint}`)
                if (row.vintage_start !== null) {
                  lines.push(
                    `  vintages: ${row.vintage_start}-${row.vintage_end}${row.has_gaps ? ' (with gaps)' : ''}`,
                  )
                } else {
                  lines.push('  vintages: none linked')
                }
                if (row.frequency) lines.push(`  frequency: ${row.frequency}`)
                lines.push(`  indexed tables: ${row.table_count}`)
                if (row.description)
                  lines.push(`  description: ${row.description}`)
                return lines.join('\n')
              })
              .join('\n\n'),
      )
      if (rows.length > 0) {
        sections.push(
          '(Next: pass an api_endpoint to search-data-tables as api_endpoint, or to fetch-aggregate-data / fetch-dataset-geography as dataset.)',
        )
      }

      return this.createSuccessResponse(sections.join('\n\n'), {
        query: { program_string: programString },
        total_count: rows.length,
        records: rows.map((row) => ({
          component_label: row.component_label,
          component_string: row.component_string,
          api_endpoint: row.api_endpoint,
          frequency: row.frequency ?? null,
          frequency_notes: row.frequency_notes ?? null,
          vintage_start: row.vintage_start ?? null,
          vintage_end: row.vintage_end ?? null,
          has_gaps: row.has_gaps ?? null,
          table_count: row.table_count,
          description: row.description ?? null,
        })),
        caveats,
      })
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred'
      return this.createErrorResponse(
        `Failed to list survey components: ${errorMessage}`,
      )
    }
  }
}
