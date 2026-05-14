import { Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { BaseTool } from './base.tool.js'
import { formatAggregateResponse } from '../helpers/response-format.js'
import {
  fetchVariablesIndex,
  suggestCellCodes,
  VariablesIndex,
} from '../helpers/variables-cache.js'
import {
  FetchAggregateDataToolSchema,
  TableArgs,
  TableSchema,
} from '../schema/fetch-aggregate-data.schema.js'
import { ToolContent } from '../types/base.types.js'

import {
  datasetValidator,
  validateGeographyArgs,
} from '../schema/validators.js'

export const toolDescription = `Fetches Census Bureau statistics for a dataset, vintage, and geography; never guess cell codes -- use search-data-tables first or this tool will reject unknown codes with a "did you mean" hint. Every ACS estimate is auto-paired with its margin of error and flagged LOW RELIABILITY when CV exceeds 30%; suppression sentinels are decoded to text rather than returned as numbers. Required: dataset, year, get (variables or group), and one of for/ucgid. Returns numbered Record blocks with caveats led at the top.`

export class FetchAggregateDataTool extends BaseTool<TableArgs> {
  name = 'fetch-aggregate-data'
  description = toolDescription
  inputSchema: Tool['inputSchema'] = TableSchema as Tool['inputSchema']
  readonly requiresApiKey = true

  get argsSchema() {
    return FetchAggregateDataToolSchema.superRefine((args, ctx) => {
      //Check that the correct tool is used to fetch data
      const identifiedDataset = datasetValidator(args.dataset)

      if (identifiedDataset.tool !== this.name) {
        ctx.addIssue({
          path: ['dataset'],
          code: z.ZodIssueCode.custom,
          message: identifiedDataset.message,
        })
      }

      validateGeographyArgs(args, ctx)
    })
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
  }

  validateArgs(input: unknown) {
    return this.argsSchema.safeParse(input)
  }

  async toolHandler(
    args: TableArgs,
    apiKey: string,
  ): Promise<{ content: ToolContent[] }> {
    const baseUrl = `https://api.census.gov/data/${args.year}/${args.dataset}`

    // Load variables.json best-effort. Used for cell-code validation, MOE
    // pairing, and human labels. Failure is silent.
    const variablesIndex = await fetchVariablesIndex(
      args.dataset,
      args.year,
      apiKey,
    )

    const requestedVariables = args.get.variables ?? []
    const requestedGroup = args.get.group

    // Validate requested cell codes against the variables catalog. Reject
    // typos with a "did you mean" hint rather than forwarding to the API.
    if (variablesIndex && requestedVariables.length > 0) {
      const unknown = requestedVariables.filter(
        (v) => !variablesIndex.byName.has(v),
      )
      if (unknown.length > 0) {
        const hints = unknown
          .map((v) => {
            const suggestions = suggestCellCodes(variablesIndex, v)
            const hint =
              suggestions.length > 0
                ? ` -- did you mean ${suggestions.join(', ')}?`
                : ''
            return `  - ${v}${hint}`
          })
          .join('\n')
        return this.createErrorResponse(
          `Unknown cell code(s) for ${args.dataset} ${args.year}:\n${hints}\n\n` +
            `Use search-data-tables to discover the correct codes before calling fetch-aggregate-data.`,
        )
      }
    }

    // Auto-pair every requested estimate with its MOE companion. The
    // companion already-present case is a no-op via the Set dedupe.
    const autoAddedMoeFields: string[] = []
    const variablesWithMoe = new Set(requestedVariables)
    if (variablesIndex && requestedVariables.length > 0) {
      for (const v of requestedVariables) {
        const meta = variablesIndex.byName.get(v)
        if (meta?.moePair && !variablesWithMoe.has(meta.moePair)) {
          variablesWithMoe.add(meta.moePair)
          autoAddedMoeFields.push(meta.moePair)
        }
      }
    }

    let getParams = ''
    const effectiveVariables = Array.from(variablesWithMoe)
    if (effectiveVariables.length > 0) {
      getParams = effectiveVariables.join(',')
    }
    if (requestedGroup) {
      if (getParams !== '') getParams += ','
      getParams += `group(${requestedGroup})`
    }

    const query = new URLSearchParams({
      get: getParams,
    })

    if (args.for) query.append('for', args.for)
    if (args.in) query.append('in', args.in)
    if (args.ucgid) query.append('ucgid', args.ucgid)

    if (args.predicates) {
      for (const [key, value] of Object.entries(args.predicates)) {
        query.append(key, value)
      }
    }

    const descriptive = args.descriptive?.toString() ?? 'false'
    query.append('descriptive', descriptive)
    query.append('key', apiKey)

    const url = `${baseUrl}?${query.toString()}`

    try {
      const fetch = (await import('node-fetch')).default
      const res = await fetch(url)

      console.log(`URL Attempted: ${url.replace(/key=[^&]*/g, 'key=REDACTED')}`)

      if (!res.ok) {
        return this.createErrorResponse(
          buildApiErrorMessage(res.status, res.statusText, {
            dataset: args.dataset,
            year: args.year,
            variablesAvailable: variablesIndex !== null,
          }),
        )
      }

      const data = (await res.json()) as string[][]
      const [headers, ...rows] = data

      const queryEcho = buildQueryEcho({
        dataset: args.dataset,
        year: args.year,
        get: getParams,
        forParam: args.for,
        inParam: args.in,
        ucgid: args.ucgid,
        predicates: args.predicates,
      })

      const formatted = formatAggregateResponse({
        dataset: args.dataset,
        year: args.year,
        url,
        headers,
        rows,
        queryEcho,
        requestedVariables,
        autoAddedMoeFields,
        variablesIndex: variablesIndex as VariablesIndex | null,
        currentYear: new Date().getUTCFullYear(),
      })

      return this.createSuccessResponse(formatted)
    } catch (err) {
      return this.createErrorResponse(`Fetch failed: ${(err as Error).message}`)
    }
  }
}

// Builds an actionable error message that pushes the model back toward the
// discovery tools. Descriptive (not prescriptive): we tell the user to retry
// via the discovery path rather than handing back a parameter value they
// might parrot.
function buildApiErrorMessage(
  status: number,
  statusText: string,
  ctx: {
    dataset: string
    year: number | string
    variablesAvailable: boolean
  },
): string {
  const lines: string[] = []
  lines.push(`Census API returned ${status} ${statusText}.`)

  if (status === 404) {
    lines.push(
      `The dataset/year combination (dataset=${ctx.dataset}, year=${ctx.year}) was not found.`,
    )
    if (!ctx.variablesAvailable) {
      lines.push(
        `Variables metadata for this dataset/year was also unavailable, ` +
          `which usually indicates the combination does not exist.`,
      )
    }
    lines.push(
      `Recover by calling list-datasets to confirm the dataset exists and which vintages are published.`,
    )
  } else if (status === 400) {
    lines.push(
      `The Census API rejected the query as malformed.`,
      `Re-verify the geography (for/in/ucgid) via fetch-dataset-geography and ` +
        `resolve-geography-fips, and re-verify cell codes via search-data-tables.`,
    )
  } else {
    lines.push(
      `Retry after a short delay; if the failure persists, call list-datasets to confirm the dataset is still published.`,
    )
  }
  return lines.join(' ')
}

function buildQueryEcho(opts: {
  dataset: string
  year: number | string
  get: string
  forParam?: string
  inParam?: string
  ucgid?: string
  predicates?: Record<string, string>
}): string {
  const parts: string[] = [
    `get=${opts.get}`,
    `dataset=${opts.dataset}`,
    `year=${opts.year}`,
  ]
  if (opts.forParam) parts.push(`for=${opts.forParam}`)
  if (opts.inParam) parts.push(`in=${opts.inParam}`)
  if (opts.ucgid) parts.push(`ucgid=${opts.ucgid}`)
  if (opts.predicates) {
    for (const [k, v] of Object.entries(opts.predicates)) {
      parts.push(`${k}=${v}`)
    }
  }
  return parts.join(', ')
}
