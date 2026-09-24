import { Tool } from '@modelcontextprotocol/sdk/types.js'

import {
  AllDatasetMetadataJsonSchema,
  AllDatasetMetadataJsonResponseType,
  ListDatasetsArgs,
  ListDatasetsArgsSchema,
  ListDatasetsInputSchema,
  ListDatasetsOutputSchema,
  SimplifiedAPIDatasetType,
  AggregatedResultType,
  DatasetType,
} from '../schema/list-datasets.schema.js'

import { BaseTool } from './base.tool.js'

import { fetchWithTimeout } from '../helpers/http.js'
import { ToolCaveat, ToolResponse } from '../types/base.types.js'

export const toolDescription = `Returns Census catalog entries -- dataset IDs, titles, and published vintages; never guess a dataset_id. Pass dataset (exact ID, e.g. "acs/acs5") to check one dataset's vintages, or query (words matched against ID and title, e.g. "acs5 profile") to search. With no arguments it returns the whole catalog (~250 datasets, about 37 KB) -- avoid that unless you need it. For orientation prefer the guided flow list-survey-programs -> list-survey-components.`

// Module-level cache — persists across warm Lambda invocations so repeated
// calls don't refetch Census's ~2MB data.json catalog every time. Holds the
// aggregated array (not just its JSON string) so cache hits can rebuild
// both the text and the structuredContent channels.
const CATALOG_TTL_MS = 60 * 60 * 1000
let catalogCache: {
  aggregated: AggregatedResultType[]
  json: string
  expiresAt: number
} | null = null

// Test hook, mirroring clearVariablesCache in variables-cache.ts.
export function clearCatalogCache(): void {
  catalogCache = null
}

export class ListDatasetsTool extends BaseTool<ListDatasetsArgs> {
  name = 'list-datasets'
  title = 'List Datasets'
  description = toolDescription
  readonly requiresApiKey = true

  inputSchema: Tool['inputSchema'] =
    ListDatasetsArgsSchema as Tool['inputSchema']
  outputSchema: Tool['inputSchema'] =
    ListDatasetsOutputSchema as Tool['inputSchema']

  get argsSchema() {
    return ListDatasetsInputSchema
  }

  constructor() {
    super()
    this.handler = this.handler.bind(this)
  }

  private isValidMetadataResponse(
    data: unknown,
  ): data is AllDatasetMetadataJsonResponseType {
    try {
      AllDatasetMetadataJsonSchema.parse(data)
      return true
    } catch {
      return false
    }
  }

  private simplifyDataset(dataset: DatasetType) {
    const simplified: SimplifiedAPIDatasetType = {
      c_dataset: Array.isArray(dataset.c_dataset)
        ? dataset.c_dataset.join('/')
        : dataset.c_dataset,
      title: dataset.title,
    }
    if ('c_vintage' in dataset) simplified.c_vintage = dataset.c_vintage
    if ('c_isAggregate' in dataset)
      simplified.c_isAggregate = dataset.c_isAggregate
    return simplified
  }

  private cleanTitle(title: string, vintage?: number): string {
    if (vintage === undefined) return title

    const vintageStr = vintage.toString()

    // Avoid matching vintage if it's part of a number-number pattern (like 2018-2022)
    const regex = new RegExp(
      `(?<!\\d\\s*-\\s*)\\b${vintageStr}\\b(?!\\s*-\\s*\\d)`,
    )

    // Replace only the first vintage while preserving spacing
    return title
      .replace(regex, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  // Aggregate by c_dataset, create arrays vintages and keep only latest title
  private aggregateDatasets(
    data: SimplifiedAPIDatasetType[],
  ): AggregatedResultType[] {
    const grouped = new Map<string, AggregatedResultType>()

    for (const entry of data) {
      // Filter out datasets that do not have c_isAggregate: true
      if (entry.c_isAggregate !== true) {
        continue
      }

      const key = entry.c_dataset
      const vintage = entry.c_vintage

      const cleanedTitle = this.cleanTitle(entry.title, vintage)

      if (!grouped.has(key)) {
        grouped.set(key, {
          dataset: entry.c_dataset,
          title: cleanedTitle,
          years:
            vintage !== undefined && typeof vintage === 'number'
              ? [vintage]
              : [],
        })
      } else {
        const existing = grouped.get(key)!

        if (!existing.years) {
          existing.years = []
        }

        // Add vintage if it's a number and not already present
        if (
          vintage !== undefined &&
          typeof vintage === 'number' &&
          !existing.years.includes(vintage)
        ) {
          existing.years.push(vintage)
        }
      }
    }

    // Sort vintages for each entry (ascending order)
    for (const entry of grouped.values()) {
      entry.years?.sort((a, b) => a - b)
    }

    return Array.from(grouped.values())
  }

  // Applies the optional filters to the cached catalog and builds both
  // channels from the same filtered array. The text stays the JSON it has
  // always been, led by any caveats so a NO_MATCH is never silent.
  private respond(
    catalog: AggregatedResultType[],
    catalogJson: string,
    args: ListDatasetsArgs,
  ): ToolResponse {
    const filtered = filterCatalog(catalog, args)
    const caveats: ToolCaveat[] = []
    if (filtered.length === 0 && (args.dataset || args.query)) {
      caveats.push({
        code: 'NO_MATCH',
        message: args.dataset
          ? `No aggregate dataset has the exact ID "${args.dataset}". Retry with query instead (e.g. query="${args.dataset}") to see near matches.`
          : `No dataset ID or title contains every word of "${args.query}". Retry with fewer or broader words.`,
      })
    }

    const json =
      filtered === catalog
        ? catalogJson
        : JSON.stringify(filtered, (_key, value) =>
            value === null ? undefined : value,
          )
    const text =
      caveats.length > 0
        ? `${caveats.map((c) => `**${c.code}:** ${c.message}`).join('\n\n')}\n\n${json}`
        : json

    return this.createSuccessResponse(text, {
      query: { query: args.query ?? null, dataset: args.dataset ?? null },
      catalog_count: catalog.length,
      total_count: filtered.length,
      datasets: filtered,
      caveats,
    })
  }

  async toolHandler(
    args: ListDatasetsArgs,
    apiKey: string,
  ): Promise<ToolResponse> {
    const now = Date.now()
    if (catalogCache && catalogCache.expiresAt > now) {
      return this.respond(catalogCache.aggregated, catalogCache.json, args)
    }

    try {
      const catalogUrl = `https://api.census.gov/data.json?key=${apiKey}`

      // The full catalog is ~2MB, so allow longer than the default timeout.
      const response = await fetchWithTimeout(catalogUrl, 20_000)
      if (!response.ok) {
        return this.createErrorResponse(
          `Census catalog returned ${response.status} ${response.statusText}. Retry after a short delay; if the failure persists the Census Data API may be unavailable.`,
        )
      }

      const data = await response.json()
      if (!this.isValidMetadataResponse(data)) {
        return this.createErrorResponse(
          'Catalog response did not match the expected metadata schema. The Census Data API may have returned an unexpected payload; retry, and if the failure persists report it as a catalog-format issue.',
        )
      }

      let simplified = data.dataset.map(this.simplifyDataset)
      // Deterministically sort: group by c_dataset, newest vintage first
      simplified = simplified.sort((a, b) => {
        const datasetCompare = a.c_dataset.localeCompare(b.c_dataset)
        if (datasetCompare !== 0) return datasetCompare

        return (b.c_vintage ?? 0) - (a.c_vintage ?? 0) // descending vintage
      })

      const aggregated = this.aggregateDatasets(simplified)

      const json = JSON.stringify(aggregated, (key, value) => {
        return value === null ? undefined : value
      })

      catalogCache = { aggregated, json, expiresAt: now + CATALOG_TTL_MS }

      return this.respond(aggregated, json, args)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred'
      return this.createErrorResponse(
        `Failed to fetch datasets: ${errorMessage}. Retry once network connectivity to api.census.gov is restored.`,
      )
    }
  }
}

// dataset is an exact (case-insensitive) ID match; query requires every
// whitespace-separated word to appear in the ID or title. Both may be
// combined. With neither, the catalog array itself is returned so the
// caller can reuse its cached JSON.
export function filterCatalog(
  catalog: AggregatedResultType[],
  args: ListDatasetsArgs,
): AggregatedResultType[] {
  if (!args.dataset && !args.query) return catalog
  const exact = args.dataset?.toLowerCase()
  const words = args.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? []
  return catalog.filter((entry) => {
    if (exact && entry.dataset.toLowerCase() !== exact) return false
    const haystack = `${entry.dataset} ${entry.title}`.toLowerCase()
    return words.every((w) => haystack.includes(w))
  })
}
