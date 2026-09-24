import { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import { DatabaseService } from '../services/database.service.js'
import {
  ResolveGeographyFipsArgs,
  ResolveGeographyFipsArgsSchema,
  ResolveGeographyFipsInputSchema,
  ResolveGeographyFipsOutputSchema,
} from '../schema/resolve-geography-fips.schema.js'

import { GeographySearchResultRow } from '../types/geography.types.js'
import { SummaryLevelRow } from '../types/summary-level.types.js'
import { ToolCaveat, ToolResponse } from '../types/base.types.js'

export const toolDescription = `Call this to convert a place name into Census FIPS codes; never guess FIPS digits. Accepts a natural-language geography_name (e.g. "Philadelphia", "Cook County") and an optional summary_level filter. Returns, for each match, its official name, summary level, and centroid, plus the for/in query strings (carrying the FIPS codes) to pass straight to fetch-aggregate-data.`
export class ResolveGeographyFipsTool extends BaseTool<ResolveGeographyFipsArgs> {
  name = 'resolve-geography-fips'
  title = 'Resolve Geography FIPS'
  description = toolDescription
  readonly requiresApiKey = false

  private dbService: DatabaseService

  inputSchema: Tool['inputSchema'] =
    ResolveGeographyFipsArgsSchema as Tool['inputSchema']
  outputSchema: Tool['inputSchema'] =
    ResolveGeographyFipsOutputSchema as Tool['inputSchema']

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

  async toolHandler(args: ResolveGeographyFipsArgs): Promise<ToolResponse> {
    try {
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
        // Zero matches is still a successful, schema-conforming result:
        // this path must emit structuredContent too (total_count 0 = the
        // search ran and matched a known, complete count of zero).
        return this.createSuccessResponse(
          [
            `## Result`,
            `No geographies matched "${args.geography_name}"${
              args.summary_level
                ? ` at summary level "${args.summary_level}"`
                : ''
            }.`,
            ``,
            `Retry with a broader geography_name (drop modifiers like "city" or "County"), or omit summary_level entirely. Names are fuzzy-matched against official Census names such as "Cook County, Illinois", so a shorter distinctive part of the name usually works better than a longer description.`,
          ].join('\n'),
          {
            query: {
              geography_name: args.geography_name,
              summary_level_requested: args.summary_level ?? null,
              summary_level_resolved: summaryLevelResolved,
            },
            total_count: 0,
            shown_count: 0,
            records: [],
            caveats: [
              {
                code: 'NO_MATCH',
                message: `No geographies matched "${args.geography_name}". A miss here means "not found under this spelling", not "does not exist" -- retry with a broader name.`,
              },
            ],
          },
        )
      }

      const limit = args.limit ?? 25
      const truncated = result.length > limit
      const visible = truncated ? result.slice(0, limit) : result

      const formatted = formatGeographyResults({
        query: args.geography_name,
        summaryLevelRequested: args.summary_level ?? null,
        summaryLevelResolved,
        totalMatches: result.length,
        visible,
        truncated,
      })

      return this.createSuccessResponse(formatted.text, formatted.structured)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred'

      return this.createErrorResponse(
        `Failed to resolve geography: ${errorMessage}`,
      )
    }
  }
}

// Render geographies as numbered Record blocks rather than a JSON dump so the
// shape survives Copilot's renderer. The `for` and `in` query params are the
// load-bearing fields downstream callers need, so they go first.
// The caveat list is built ONCE and drives both the rendered prose and the
// structuredContent caveats array, so the two channels cannot drift.
function formatGeographyResults(opts: {
  query: string
  summaryLevelRequested: string | null
  summaryLevelResolved: string | null
  totalMatches: number
  visible: GeographySearchResultRow[]
  truncated: boolean
}): { text: string; structured: Record<string, unknown> } {
  const caveats: ToolCaveat[] = []

  if (opts.truncated) {
    caveats.push({
      code: 'TRUNCATED',
      message: `matched ${opts.totalMatches} geographies; showing the top ${opts.visible.length}. Narrow geography_name or pass summary_level to filter further.`,
    })
  }
  if (opts.summaryLevelRequested && !opts.summaryLevelResolved) {
    caveats.push({
      code: 'SUMMARY_LEVEL_IGNORED',
      message: `summary_level "${opts.summaryLevelRequested}" matched no known summary level and was ignored; results cover all levels.`,
    })
  }

  const sections: string[] = []

  if (caveats.length > 0) {
    sections.push(
      `## Caveats`,
      caveats.map((c) => `**${c.code}:** ${c.message}`).join('\n\n'),
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

  const structured: Record<string, unknown> = {
    query: {
      geography_name: opts.query,
      summary_level_requested: opts.summaryLevelRequested,
      summary_level_resolved: opts.summaryLevelResolved,
    },
    total_count: opts.totalMatches,
    shown_count: opts.visible.length,
    records: opts.visible.map((row) => ({
      name: row.name,
      summary_level: row.summary_level_name,
      for: row.for_param,
      in: row.in_param ?? null,
      latitude: typeof row.latitude === 'number' ? row.latitude : null,
      longitude: typeof row.longitude === 'number' ? row.longitude : null,
    })),
    caveats,
  }

  return { text: sections.join('\n\n'), structured }
}
