const mockFetch = vi.fn()
vi.mock('node-fetch', () => ({ default: mockFetch }))

import { beforeEach, describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'

import {
  clearCatalogCache,
  filterCatalog,
  ListDatasetsTool,
} from '../../../src/tools/list-datasets.tool'
import { ListDatasetsOutputSchema } from '../../../src/schema/list-datasets.schema'
import { sampleDatasetMetadata } from '../../helpers/test-data.js'

const catalog = [
  {
    dataset: 'acs/acs1',
    title: 'American Community Survey: 1-Year Estimates: Detailed Tables',
    years: [2022, 2023],
  },
  {
    dataset: 'acs/acs5',
    title: 'American Community Survey: 5-Year Estimates: Detailed Tables',
    years: [2023],
  },
  {
    dataset: 'acs/acs5/profile',
    title: 'American Community Survey: 5-Year Estimates: Data Profiles',
    years: [2023],
  },
  { dataset: 'cbp', title: 'County Business Patterns', years: [2022] },
]

describe('filterCatalog', () => {
  it('returns the catalog array itself when unfiltered', () => {
    expect(filterCatalog(catalog, {})).toBe(catalog)
  })

  it('matches dataset exactly and case-insensitively (no prefix matches)', () => {
    expect(
      filterCatalog(catalog, { dataset: 'ACS/acs5' }).map((d) => d.dataset),
    ).toEqual(['acs/acs5'])
  })

  it('requires every query word to appear in the ID or title', () => {
    expect(
      filterCatalog(catalog, { query: 'acs5 profile' }).map((d) => d.dataset),
    ).toEqual(['acs/acs5/profile'])
    expect(
      filterCatalog(catalog, { query: 'county business' }).map(
        (d) => d.dataset,
      ),
    ).toEqual(['cbp'])
  })

  it('combines dataset and query', () => {
    expect(
      filterCatalog(catalog, { dataset: 'acs/acs5', query: 'profile' }),
    ).toEqual([])
  })
})

describe('ListDatasetsTool filtering', () => {
  const ajv = new Ajv({ allowUnionTypes: true })
  const validate = ajv.compile(ListDatasetsOutputSchema)
  let tool: ListDatasetsTool

  beforeEach(() => {
    clearCatalogCache()
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...sampleDatasetMetadata,
        dataset: [
          { ...sampleDatasetMetadata.dataset[0], c_isAggregate: true },
          {
            ...sampleDatasetMetadata.dataset[0],
            c_dataset: ['cbp'],
            title: 'County Business Patterns',
            c_isAggregate: true,
          },
        ],
      }),
    })
    tool = new ListDatasetsTool()
  })

  it('returns only the matching datasets with conforming structuredContent', async () => {
    const result = await tool.toolHandler({ query: 'business' }, 'KEY')
    expect(JSON.parse(result.content[0].text)).toEqual([
      { dataset: 'cbp', title: 'County Business Patterns', years: [2022] },
    ])
    expect(validate(result.structuredContent)).toBe(true)
    expect(result.structuredContent).toMatchObject({
      query: { query: 'business', dataset: null },
      catalog_count: 2,
      total_count: 1,
      caveats: [],
    })
  })

  it('reports a filter miss as NO_MATCH in both channels', async () => {
    const result = await tool.toolHandler({ dataset: 'acs/acs5' }, 'KEY')
    const structured = result.structuredContent as {
      total_count: number
      caveats: { code: string; message: string }[]
    }
    expect(result.isError).toBeUndefined()
    expect(validate(structured)).toBe(true)
    expect(structured.total_count).toBe(0)
    expect(structured.caveats.map((c) => c.code)).toEqual(['NO_MATCH'])
    expect(result.content[0].text).toContain(structured.caveats[0].message)
  })

  it('serves filters from the warm catalog cache without refetching', async () => {
    await tool.toolHandler({}, 'KEY')
    const filtered = await tool.toolHandler({ dataset: 'cbp' }, 'KEY')
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(
      (filtered.structuredContent as { total_count: number }).total_count,
    ).toBe(1)
  })
})
