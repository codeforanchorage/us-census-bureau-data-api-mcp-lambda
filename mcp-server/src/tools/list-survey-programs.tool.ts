// Ported from upstream PR #141 and adapted to this fork's conventions:
// title/annotations, binding outputSchema + structuredContent, caveats
// with stable codes, Record-block text for the Copilot renderer, and the
// sanitized database error path. Upstream positioned this pair as a
// REPLACEMENT for list-datasets; we keep list-datasets (it is the only
// complete vintage catalog) and position these as the guided entry point.
import { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import { DatabaseService } from '../services/database.service.js'
import {
  ListSurveyProgramsArgs,
  ListSurveyProgramsArgsSchema,
  ListSurveyProgramsInputSchema,
  ListSurveyProgramsOutputSchema,
} from '../schema/list-survey-programs.schema.js'
import { SurveyProgramRow } from '../types/survey-program.types.js'
import { ToolCaveat, ToolResponse } from '../types/base.types.js'

export const toolDescription = `Call this FIRST to orient: returns all ~30 Census Bureau survey programs with a count of indexed data tables each. Guided workflow: list-survey-programs -> list-survey-components -> search-data-tables -> fetch-dataset-geography -> resolve-geography-fips -> fetch-aggregate-data. Table indexing is concentrated in ACS (~83% of indexed tables); a program with table_count 0 has nothing indexed in search-data-tables but may still be queryable via fetch-aggregate-data with known variable names. For the complete dataset/vintage catalog use list-datasets.`

export class ListSurveyProgramsTool extends BaseTool<ListSurveyProgramsArgs> {
  name = 'list-survey-programs'
  title = 'List Survey Programs'
  description = toolDescription
  readonly requiresApiKey = false

  private dbService: DatabaseService

  inputSchema: Tool['inputSchema'] =
    ListSurveyProgramsArgsSchema as Tool['inputSchema']
  outputSchema: Tool['inputSchema'] =
    ListSurveyProgramsOutputSchema as Tool['inputSchema']

  get argsSchema() {
    return ListSurveyProgramsInputSchema
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
    this.dbService = DatabaseService.getInstance()
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async toolHandler(args: ListSurveyProgramsArgs): Promise<ToolResponse> {
    try {
      const isDbHealthy = await this.dbService.healthCheck()
      if (!isDbHealthy) {
        return this.createErrorResponse(
          'Database connection failed; cannot list survey programs. Retry after a short delay.',
        )
      }

      const result = await this.dbService.query<SurveyProgramRow>(
        `SELECT * FROM list_survey_programs()`,
        [],
      )
      const rows = result.rows

      const caveats: ToolCaveat[] = []
      const unindexed = rows.filter((r) => r.table_count === 0)
      if (unindexed.length > 0) {
        caveats.push({
          code: 'NO_INDEXED_TABLES',
          message: `${unindexed.length} of ${rows.length} programs have no tables indexed in search-data-tables. That means table discovery cannot cover them -- not that the Census has no data for them; fetch-aggregate-data with known variable names may still work.`,
        })
      }
      if (rows.length === 0) {
        caveats.push({
          code: 'NO_MATCH',
          message:
            'No survey programs found -- the programs table appears to be unseeded. Report this; it is a data problem, not an absence of Census programs.',
        })
      }

      const sections: string[] = []
      if (caveats.length > 0) {
        sections.push(
          '## Caveats',
          caveats.map((c) => `**${c.code}:** ${c.message}`).join('\n\n'),
        )
      }
      sections.push('## Records')
      sections.push(
        rows.length === 0
          ? '(no survey programs found)'
          : rows
              .map((row, i) => {
                const lines = [`Record ${i + 1}:`]
                lines.push(`  program: ${row.program_label}`)
                lines.push(`  program_string: ${row.program_string}`)
                lines.push(`  indexed tables: ${row.table_count}`)
                if (row.description)
                  lines.push(`  description: ${row.description}`)
                return lines.join('\n')
              })
              .join('\n\n'),
      )
      sections.push(
        '(Next: pass a program_string to list-survey-components to see its concrete datasets and vintages.)',
      )

      return this.createSuccessResponse(sections.join('\n\n'), {
        total_count: rows.length,
        records: rows.map((row) => ({
          program_label: row.program_label,
          program_string: row.program_string,
          description: row.description ?? null,
          table_count: row.table_count,
        })),
        caveats,
      })
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred'
      return this.createErrorResponse(
        `Failed to list survey programs: ${errorMessage}`,
      )
    }
  }
}
