import { Tool } from '@modelcontextprotocol/sdk/types.js'

import { BaseTool } from './base.tool.js'
import { FetchAggregateDataTool } from './fetch-aggregate-data.tool.js'
import { acsDataset } from '../helpers/acs-product.js'
import { fetchWithTimeout } from '../helpers/http.js'
import { INDICATORS, IndicatorId } from '../helpers/indicators.js'
import { fetchVariablesIndex } from '../helpers/variables-cache.js'
import {
  GetIndicatorArgs,
  GetIndicatorArgsSchema,
  GetIndicatorInputSchema,
  GetIndicatorOutputSchema,
} from '../schema/get-indicator.schema.js'
import { validateGeographyArgs } from '../schema/validators.js'
import { ToolResponse } from '../types/base.types.js'

export const toolDescription = `Shortcut for common Census statistics: one call returns a headline indicator for a geography, with its margin of error, reliability flag and citation. Indicators: population, median_age, median_household_income, per_capita_income, poverty_rate, unemployment_rate (ACS), bachelors_or_higher, uninsured_rate, mean_commute_minutes, median_gross_rent, median_home_value, owner_occupied_share, median_housing_cost, and decennial_population (2020 count). Give the geography as for/in or ucgid -- get them from resolve-geography-fips, never guess FIPS codes. Several geographies (a wildcard or list) compare places on one vintage. ACS product defaults to "auto" (1-year for a single area of 65,000+ people, otherwise 5-year) and year to the latest published vintage; the ACS PRODUCT caveat says which product and period were used. Each value is checked against the cell's published label for that vintage, because Census reuses some codes for different statistics across years. For anything not on this list use search-data-tables -> list-table-variables -> fetch-aggregate-data.`

// The latest published ACS vintage moves once a year; cache the probe per
// warm container so default-year calls cost one metadata request at most.
const LATEST_TTL_MS = 6 * 60 * 60 * 1000
const latestCache = new Map<string, { year: number; at: number }>()

export function clearLatestVintageCache() {
  latestCache.clear()
}

export class GetIndicatorTool extends BaseTool<GetIndicatorArgs> {
  name = 'get-indicator'
  title = 'Get Indicator'
  description = toolDescription
  inputSchema: Tool['inputSchema'] =
    GetIndicatorInputSchema as Tool['inputSchema']
  outputSchema: Tool['inputSchema'] =
    GetIndicatorOutputSchema as Tool['inputSchema']
  readonly requiresApiKey = true

  private fetchTool = new FetchAggregateDataTool()

  get argsSchema() {
    return GetIndicatorArgsSchema.superRefine((args, ctx) => {
      validateGeographyArgs(
        args as Parameters<typeof validateGeographyArgs>[0],
        ctx,
      )
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
    args: GetIndicatorArgs,
    apiKey: string,
  ): Promise<ToolResponse> {
    const id = args.indicator as IndicatorId
    const spec = INDICATORS[id]
    const geo = { for: args.for, in: args.in, ucgid: args.ucgid }
    const get = { variables: [spec.variable] }

    let response: ToolResponse
    if (spec.source.kind === 'decennial') {
      if (args.year !== undefined && args.year !== spec.source.year) {
        return this.createErrorResponse(
          `${id} is the ${spec.source.year} Decennial Census count only; year ${args.year} is not available. ` +
            `Omit year, or use indicator "population" for an ACS estimate in other years.`,
        )
      }
      response = await this.fetchTool.toolHandler(
        { dataset: spec.source.dataset, year: spec.source.year, get, ...geo },
        apiKey,
      )
    } else {
      const product = args.product ?? 'auto'
      const probeDataset = acsDataset(
        product === '5-year' ? '5-year' : '1-year',
        spec.source.suffix,
      )
      const year = args.year ?? (await latestVintage(probeDataset))
      response = await this.fetchTool.toolHandler(
        {
          dataset: probeDataset,
          product,
          year,
          get,
          ...geo,
        },
        apiKey,
      )
    }

    if (response.isError) return response

    const sc = response.structuredContent as {
      source: { dataset: string; vintage: string }
    } & Record<string, unknown>

    // Refuse a code whose published label is not this indicator in the
    // vintage actually queried (see the note in helpers/indicators.ts).
    const index = await fetchVariablesIndex(
      sc.source.dataset,
      Number(sc.source.vintage),
      apiKey,
    )
    const published = index?.byName.get(spec.variable)?.label
    if (published === undefined) {
      return this.createErrorResponse(
        `Could not verify ${spec.variable} against the published variable list for ` +
          `${sc.source.dataset} ${sc.source.vintage} (the Census variables endpoint did not answer). ` +
          `Retry shortly; the value is withheld rather than served unverified.`,
      )
    }
    if (!spec.label.test(published)) {
      return this.createErrorResponse(
        `${id} is not available for ${sc.source.dataset} ${sc.source.vintage}: cell ${spec.variable} ` +
          `is published there as "${published}", which is a different statistic. ` +
          `Use another year, or find the table with search-data-tables and list-table-variables.`,
      )
    }

    const indicator = {
      id,
      title: spec.title,
      description: spec.description,
      unit: spec.unit,
      variable: spec.variable,
      published_label: published,
    }
    const text = (response.content[0] as { text: string }).text
    // Caveats keep leading the response (the Copilot renderer relies on
    // it); the indicator block goes just before Source.
    const block =
      `## Indicator\n${spec.title} (${spec.unit}) -- ${spec.description} ` +
      `Census cell ${spec.variable}, published as "${published}".\n\n`
    const merged = text.includes('## Source')
      ? text.replace('## Source', `${block}## Source`)
      : `${block}${text}`

    return this.createSuccessResponse(merged, { indicator, ...sc })
  }
}

// Latest vintage of an ACS dataset: last calendar year if its metadata is
// published, otherwise the year before. A failed probe (outage) falls back
// to the older year, which is always published.
async function latestVintage(dataset: string): Promise<number> {
  const cached = latestCache.get(dataset)
  if (cached && Date.now() - cached.at < LATEST_TTL_MS) return cached.year

  const candidate = new Date().getUTCFullYear() - 1
  let year = candidate - 1
  try {
    const res = await fetchWithTimeout(
      `https://api.census.gov/data/${candidate}/${dataset}.json`,
    )
    if (res.ok) year = candidate
  } catch {
    // keep the older, always-published year
  }
  latestCache.set(dataset, { year, at: Date.now() })
  return year
}
