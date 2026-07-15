import { Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { BaseTool } from './base.tool.js'
import { fetchWithTimeout } from '../helpers/http.js'
import { formatAggregateResponse } from '../helpers/response-format.js'
import {
  CacheDuration,
  CacheDurationUnit,
  QueryCacheService,
} from '../services/queryCache.service.js'
import {
  fetchVariablesIndex,
  suggestCellCodes,
  suggestGroupCodes,
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

export const toolDescription = `Fetches Census statistics for a dataset, vintage, and geography. Never guess cell codes -- run search-data-tables first. ACS estimates are auto-paired with their margin of error and flagged LOW RELIABILITY above CV 30%; suppression sentinels are decoded to text. MOE pairing doubles the variable count against the Census 50-variable cap, so pass at most 25 variables per call for ACS datasets (group requests are exempt). ACS 1-year (acs/acs1) only covers areas of 65,000+ people; use acs/acs5 for smaller geographies. Responses show at most 100 records -- truncation is display-side, the full result is still fetched upstream -- so narrow wildcard geographies; unbounded national wildcards for high-cardinality levels (e.g. for=county:* with no in=) are rejected. Required: dataset, year, get (variables or group), and one of for/ucgid.`

// Census Data API hard limit on explicit get= variables per request.
const CENSUS_VARIABLE_LIMIT = 50

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

  private cacheService: QueryCacheService
  // Published vintages are immutable, so a long TTL is safe.
  private cacheDuration = new CacheDuration(1, CacheDurationUnit.YEAR)

  constructor() {
    super()
    this.handler = this.handler.bind(this)
    this.cacheService = QueryCacheService.getInstance()
  }

  validateArgs(input: unknown) {
    return this.argsSchema.safeParse(input)
  }

  async toolHandler(
    args: TableArgs,
    apiKey: string,
  ): Promise<{ content: ToolContent[] }> {
    // Reject unbounded national wildcards before paying for anything. The
    // 100-record cap is display-side only -- the full payload is still
    // fetched from the Census API -- so a nationwide county:*/tract:* call
    // pays full upstream cost for a result that is mostly cut away.
    const wildcardError = checkUnboundedWildcard(args.for, args.in)
    if (wildcardError) {
      return this.createErrorResponse(wildcardError)
    }

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

    // Validate the requested group (table) code the same way. A typo'd group
    // otherwise becomes an opaque 400 from the API.
    if (variablesIndex && requestedGroup) {
      if (!variablesIndex.groupNames.has(requestedGroup)) {
        const suggestions = suggestGroupCodes(variablesIndex, requestedGroup)
        const hint =
          suggestions.length > 0
            ? ` -- did you mean ${suggestions.join(', ')}?`
            : ''
        return this.createErrorResponse(
          `Unknown group code "${requestedGroup}" for ${args.dataset} ${args.year}${hint}\n\n` +
            `Use search-data-tables to discover the correct table ID before calling fetch-aggregate-data.`,
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

    // The Census API caps explicit get= variables at 50 per call. group()
    // requests are exempt -- the group expands server-side (B01001 alone
    // returns 196 columns). MOE auto-pairing above can double the requested
    // count, so check the *effective* list here and fail fast with an
    // accurate message; otherwise Census returns an opaque 400 that reads
    // as a geography/cell-code problem when neither is at fault.
    if (effectiveVariables.length > CENSUS_VARIABLE_LIMIT) {
      return this.createErrorResponse(
        `Too many variables: ${requestedVariables.length} requested, and MOE auto-pairing added ` +
          `${autoAddedMoeFields.length} margin-of-error field(s), for an effective total of ` +
          `${effectiveVariables.length} -- over the Census API limit of ${CENSUS_VARIABLE_LIMIT} variables per call. ` +
          `For ACS datasets each estimate consumes two slots (estimate + MOE), so request at most 25 ` +
          `estimate variables per call, split the request across multiple calls, or fetch the whole ` +
          `table with get.group (group requests are not subject to the 50-variable limit). ` +
          `The geography and cell codes in this request are not the problem.`,
      )
    }
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

    // Everything that changes the API response must be part of the cache key:
    // ucgid, predicates, and descriptive all do. The variables are the
    // effective (MOE-paired) list so hit and miss return identical payloads.
    const cacheParams = {
      dataset: args.dataset,
      group: requestedGroup ?? null,
      year: args.year,
      variables: effectiveVariables,
      geographySpec: JSON.stringify({
        for: args.for ?? null,
        in: args.in ?? null,
        ucgid: args.ucgid ?? null,
        predicates: args.predicates ?? null,
        descriptive,
      }),
    }

    // Cache infrastructure problems must never fail the query path.
    let data: string[][] | null = null
    try {
      data = await this.cacheService.get(cacheParams)
    } catch (err) {
      console.error(`Cache read failed: ${(err as Error).message}`)
    }

    try {
      if (data) {
        console.log(`Cache hit for ${args.dataset} ${args.year}`)
      } else {
        const res = await fetchWithTimeout(url)

        console.log(
          `URL Attempted: ${url.replace(/key=[^&]*/g, 'key=REDACTED')}`,
        )

        if (!res.ok) {
          return this.createErrorResponse(
            buildApiErrorMessage(res.status, res.statusText, {
              dataset: args.dataset,
              year: args.year,
              variablesAvailable: variablesIndex !== null,
              // When the catalog loaded, every explicit variable and group
              // was already validated above -- an unknown code cannot have
              // reached the API, so a 400 must have another cause.
              codesValidated:
                variablesIndex !== null &&
                (requestedVariables.length > 0 || requestedGroup !== undefined),
            }),
          )
        }

        // The Census API signals "valid query, zero matching data" with a 204
        // (or occasionally a 200 with an empty body) rather than an empty array.
        const bodyText = await res.text()
        if (res.status === 204 || bodyText.trim() === '') {
          return this.createErrorResponse(
            `The Census API returned no data for this query (HTTP ${res.status} with an empty body). ` +
              `The query was accepted but matched nothing. Re-verify the geography (for/in/ucgid) via ` +
              `resolve-geography-fips and that the variables are published for ${args.dataset} ${args.year} ` +
              `via search-data-tables.`,
          )
        }

        try {
          data = JSON.parse(bodyText) as string[][]
        } catch {
          return this.createErrorResponse(
            `The Census API returned a non-JSON response body. Retry after a short delay; ` +
              `if the failure persists the Census Data API may be having an outage.`,
          )
        }
        if (!Array.isArray(data) || data.length === 0) {
          return this.createErrorResponse(
            `The Census API returned an empty result set for this query. Re-verify the geography ` +
              `(for/in/ucgid) via resolve-geography-fips and the variables via search-data-tables.`,
          )
        }

        // Awaited, unlike upstream's fire-and-forget: Lambda freezes the
        // container as soon as the response returns, which would strand or
        // lose a background write. The insert is a single fast statement.
        try {
          await this.cacheService.set(cacheParams, data, this.cacheDuration)
        } catch (err) {
          console.error(`Cache write failed: ${(err as Error).message}`)
        }
      }

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

// Geography levels whose nationwide wildcard is far larger than the
// 100-record display cap. A for=<level>:* with no in= restriction fetches
// the whole nation from the Census API only to show the first 100 rows.
// Levels absent from this map (us, state, region, division, MSA,
// congressional district, ...) are small enough to allow unbounded.
const UNBOUNDED_WILDCARD_LEVELS = new Map<string, string>([
  ['county', '~3,200'],
  ['county subdivision', '~36,000'],
  ['place', '~32,000'],
  ['tract', '~85,000'],
  ['block group', '~240,000'],
  ['block', 'millions of'],
  ['zip code tabulation area', '~33,000'],
  ['public use microdata area', '~2,400'],
  ['urban area', '~2,600'],
])

function checkUnboundedWildcard(
  forParam?: string,
  inParam?: string,
): string | null {
  if (!forParam || inParam) return null
  const colonIdx = forParam.indexOf(':')
  if (colonIdx < 0) return null
  const level = forParam.slice(0, colonIdx).trim().toLowerCase()
  const values = forParam.slice(colonIdx + 1).trim()
  if (values !== '*') return null
  const approxCount = UNBOUNDED_WILDCARD_LEVELS.get(level)
  if (!approxCount) return null
  return (
    `Unbounded wildcard geography: for=${forParam} with no in= restriction requests every ` +
    `${level} in the nation (${approxCount} records), but at most 100 records can be shown ` +
    `-- the rest would be fetched and discarded. Narrow the query: add an in= parent geography ` +
    `(e.g. in=state:02) or list specific ${level} codes (use resolve-geography-fips to find them).`
  )
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
    codesValidated: boolean
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
    if (isAcs1YearDataset(ctx.dataset)) {
      lines.push(
        `ACS 1-year estimates (acs/acs1) are only published for geographic areas with ` +
          `populations of 65,000 or more, so a 400 here often means the requested area is too small. ` +
          `Switch the dataset to acs/acs5 (5-year estimates) to cover smaller geographies. ` +
          `See https://www.census.gov/programs-surveys/acs/guidance/estimates.html.`,
      )
    }
    if (ctx.codesValidated) {
      // Don't send the caller chasing causes we already ruled out: the cell
      // codes were checked against this dataset's catalog before the call.
      lines.push(
        `The Census API rejected the query as malformed. The requested cell codes were ` +
          `validated against this dataset's catalog, so they are unlikely to be the cause. ` +
          `Check the geography combination instead -- some levels require an in= parent or are ` +
          `not published for this dataset (verify via fetch-dataset-geography and ` +
          `resolve-geography-fips) -- and check any predicates.`,
      )
    } else {
      lines.push(
        `The Census API rejected the query as malformed.`,
        `Re-verify the geography (for/in/ucgid) via fetch-dataset-geography and ` +
          `resolve-geography-fips, and re-verify cell codes via search-data-tables.`,
      )
    }
  } else {
    lines.push(
      `Retry after a short delay; if the failure persists, call list-datasets to confirm the dataset is still published.`,
    )
  }
  return lines.join(' ')
}

// ACS 1-year estimates are only published for areas of 65,000+ people, a
// frequent cause of opaque 400s. Detect acs1 regardless of spacing/case so the
// error path can hand back the population-threshold hint above.
function isAcs1YearDataset(dataset: string): boolean {
  return dataset.toLowerCase().replace(/\s+/g, '').includes('acs/acs1')
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
