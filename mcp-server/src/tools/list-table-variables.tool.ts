// Closes the gap between search-data-tables (which returns table IDs) and
// fetch-aggregate-data (which wants cell codes): lists a table's variables
// straight from the dataset's variables.json, the same cached index
// fetch-aggregate-data validates against, so every code it returns is one
// fetch-aggregate-data will accept for that dataset and vintage.
import { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import {
  fetchVariablesIndex,
  prettyLabel,
  suggestGroupCodes,
  VariableMeta,
  VariablesIndex,
} from '../helpers/variables-cache.js'
import {
  ListTableVariablesArgs,
  ListTableVariablesArgsSchema,
  ListTableVariablesInputSchema,
  ListTableVariablesOutputSchema,
} from '../schema/list-table-variables.schema.js'
import { datasetValidator } from '../schema/validators.js'
import { ToolCaveat, ToolResponse } from '../types/base.types.js'

export const toolDescription = `Call this after search-data-tables to get a table's cell codes and labels for a dataset and vintage (e.g. table_id "B01001" -> B01001_002E "Total: / Male:"); never guess cell codes. Pass the codes to fetch-aggregate-data as get.variables. Only estimate codes are listed -- margin-of-error companions are paired automatically at fetch time. Use label_filter to narrow a large table.`

const DEFAULT_LIMIT = 100
// Above this many records the Record blocks become a compact fenced table
// (same threshold and renderer-safety reasoning as response-format.ts).
const COMPACT_FORMAT_THRESHOLD = 20

interface TableVariable {
  code: string
  label: string
  has_moe: boolean
}

export class ListTableVariablesTool extends BaseTool<ListTableVariablesArgs> {
  name = 'list-table-variables'
  title = 'List Table Variables'
  description = toolDescription
  readonly requiresApiKey = true

  inputSchema: Tool['inputSchema'] =
    ListTableVariablesArgsSchema as Tool['inputSchema']
  outputSchema: Tool['inputSchema'] =
    ListTableVariablesOutputSchema as Tool['inputSchema']

  get argsSchema() {
    return ListTableVariablesInputSchema
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
  }

  async toolHandler(
    args: ListTableVariablesArgs,
    apiKey: string,
  ): Promise<ToolResponse> {
    const identified = datasetValidator(args.dataset)
    if (identified.tool !== 'fetch-aggregate-data') {
      return this.createErrorResponse(identified.message)
    }

    const tableId = args.table_id.toUpperCase()
    const index = await fetchVariablesIndex(args.dataset, args.year, apiKey)
    if (!index) {
      return this.createErrorResponse(
        `Could not load the variable catalog for ${args.dataset} ${args.year}. Either that ` +
          `dataset/vintage combination is not published (confirm it with list-datasets) or ` +
          `api.census.gov is temporarily unavailable -- retry after a short delay.`,
      )
    }

    if (!index.groupNames.has(tableId)) {
      const suggestions = suggestGroupCodes(index, tableId)
      const hint =
        suggestions.length > 0 ? ` Did you mean ${suggestions.join(', ')}?` : ''
      return this.createErrorResponse(
        `Table "${tableId}" is not published in ${args.dataset} ${args.year}.${hint} ` +
          `Use search-data-tables to find the table ID, and check which dataset/year ` +
          `combinations it appears in.`,
      )
    }

    const { variables, concept } = collectTableVariables(index, tableId)
    const filter = args.label_filter?.toLowerCase()
    const matched = filter
      ? variables.filter((v) => v.label.toLowerCase().includes(filter))
      : variables
    const limit = args.limit ?? DEFAULT_LIMIT
    const visible = matched.slice(0, limit)

    const caveats: ToolCaveat[] = []
    if (filter && matched.length === 0) {
      caveats.push({
        code: 'NO_MATCH',
        message: `label_filter "${args.label_filter}" matched none of the table's ${variables.length} variables. Retry with a shorter filter or none.`,
      })
    }
    if (matched.length > visible.length) {
      caveats.push({
        code: 'TRUNCATED',
        message: `${matched.length} variables matched; showing the first ${visible.length}. Pass label_filter to narrow, raise limit (max 500), or fetch the whole table with get.group=${tableId}.`,
      })
    }

    const text = renderText({
      dataset: args.dataset,
      year: args.year,
      tableId,
      concept,
      labelFilter: args.label_filter ?? null,
      tableVariableCount: variables.length,
      visible,
      caveats,
    })

    return this.createSuccessResponse(text, {
      query: {
        dataset: args.dataset,
        year: args.year,
        table_id: tableId,
        label_filter: args.label_filter ?? null,
      },
      concept,
      table_variable_count: variables.length,
      total_count: matched.length,
      shown_count: visible.length,
      records: visible,
      caveats,
    })
  }
}

// The table's estimate variables, in code order. Margin-of-error and
// annotation companions (_M, _EA, _MA, ...) are dropped: Census lists them
// as `attributes` of their estimate (and, in older vintages, also as
// top-level variables in the same group), and fetch-aggregate-data pairs
// the MOE on its own.
export function collectTableVariables(
  index: VariablesIndex,
  tableId: string,
): { variables: TableVariable[]; concept: string | null } {
  const members: VariableMeta[] = []
  for (const meta of index.byName.values()) {
    if (meta.group === tableId) members.push(meta)
  }

  const companions = new Set<string>()
  for (const meta of members) {
    if (meta.moePair) companions.add(meta.moePair)
    for (const attr of meta.attributes?.split(',') ?? []) {
      if (attr.trim()) companions.add(attr.trim())
    }
  }

  const variables = members
    .filter((meta) => !companions.has(meta.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((meta) => ({
      code: meta.name,
      label: meta.label ? prettyLabel(meta.label) : meta.name,
      has_moe: meta.moePair !== undefined,
    }))

  const concept = members.find((m) => m.concept)?.concept ?? null
  return { variables, concept }
}

function renderText(opts: {
  dataset: string
  year: number
  tableId: string
  concept: string | null
  labelFilter: string | null
  tableVariableCount: number
  visible: TableVariable[]
  caveats: ToolCaveat[]
}): string {
  const sections: string[] = []

  if (opts.caveats.length > 0) {
    sections.push(
      '## Caveats',
      opts.caveats.map((c) => `**${c.code}:** ${c.message}`).join('\n\n'),
    )
  }

  sections.push('## Query')
  const queryLines = [
    `dataset: ${opts.dataset}`,
    `year: ${opts.year}`,
    `table_id: ${opts.tableId}`,
  ]
  if (opts.concept) queryLines.push(`concept: ${opts.concept}`)
  if (opts.labelFilter) queryLines.push(`label_filter: ${opts.labelFilter}`)
  queryLines.push(`variables in table: ${opts.tableVariableCount}`)
  sections.push(queryLines.join('\n'))

  sections.push('## Records')
  if (opts.visible.length === 0) {
    sections.push('(no variables to show)')
  } else if (opts.visible.length > COMPACT_FORMAT_THRESHOLD) {
    sections.push(
      `${opts.visible.length} variables in compact table format. Columns are delimited by " | "; ` +
        `moe = yes means a margin of error is published and will be paired automatically.`,
      [
        '```',
        'code | moe | label',
        ...opts.visible.map(
          (v) => `${v.code} | ${v.has_moe ? 'yes' : 'no'} | ${v.label}`,
        ),
        '```',
      ].join('\n'),
    )
  } else {
    sections.push(
      opts.visible
        .map((v, i) =>
          [
            `Record ${i + 1}:`,
            `  code: ${v.code}`,
            `  label: ${v.label}`,
            `  has_moe: ${v.has_moe ? 'yes' : 'no'}`,
          ].join('\n'),
        )
        .join('\n\n'),
    )
  }

  if (opts.visible.length > 0) {
    sections.push(
      `(Next: pass codes to fetch-aggregate-data as get.variables -- at most 25 per ACS call -- ` +
        `or fetch the whole table with get.group=${opts.tableId}.)`,
    )
  }

  return sections.join('\n\n')
}
