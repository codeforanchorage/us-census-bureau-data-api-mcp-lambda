const mockFetch = vi.fn()

vi.mock('node-fetch', () => ({
  default: mockFetch,
}))

vi.mock('../../../src/services/queryCache.service', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/services/queryCache.service')
  >('../../../src/services/queryCache.service')
  return {
    ...actual,
    QueryCacheService: { getInstance: vi.fn() },
  }
})

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest'
import Ajv from 'ajv'
import { QueryCacheService } from '../../../src/services/queryCache.service'
import { clearVariablesCache } from '../../../src/helpers/variables-cache'
import { FetchAggregateDataTool } from '../../../src/tools/fetch-aggregate-data.tool'
import { FetchAggregateDataOutputSchema } from '../../../src/schema/fetch-aggregate-data.schema'
import {
  acsFamily,
  isSingleGeography,
  acs1Unpublished,
} from '../../../src/helpers/acs-product'

const VARIABLES = {
  variables: {
    B01001_001E: { label: 'Estimate!!Total', group: 'B01001' },
    B01001_001M: { label: 'Margin of Error!!Total', group: 'B01001' },
    NAME: { label: 'Geographic Area Name', group: 'N/A' },
  },
}

const ROWS = [
  ['NAME', 'B01001_001E', 'B01001_001M', 'state', 'place'],
  ['Juneau city and borough, Alaska', '31685', '120', '02', '36400'],
]

type Reply = number | 'rows'
// Routes each data call by "<year>/<dataset>". Unlisted routes return rows.
function route(replies: Record<string, Reply>) {
  mockFetch.mockImplementation((url: string) => {
    const m =
      /api\.census\.gov\/data\/(\d{4})\/([^?]+?)(\/variables\.json)?(\?|$)/.exec(
        url,
      )
    const key = m ? `${m[1]}/${m[2]}` : url
    const reply = replies[key] ?? 'rows'
    if (m?.[3]) {
      return Promise.resolve(
        reply === 404
          ? new Response('not found', { status: 404 })
          : new Response(JSON.stringify(VARIABLES), { status: 200 }),
      )
    }
    if (reply === 'rows') {
      return Promise.resolve(
        new Response(JSON.stringify(ROWS), { status: 200 }),
      )
    }
    return Promise.resolve(
      new Response(reply === 204 ? null : 'error', { status: reply }),
    )
  })
}

function dataCalls(): string[] {
  return mockFetch.mock.calls
    .map(([url]) => String(url))
    .filter((url) => !url.includes('/variables.json'))
    .map((url) => /data\/(\d{4}\/[^?]+)/.exec(url)![1])
}

const base = {
  year: 2024,
  get: { variables: ['B01001_001E'] },
  for: 'place:36400',
  in: 'state:02',
}

type Result = Awaited<ReturnType<FetchAggregateDataTool['toolHandler']>>
const structured = (r: Result) =>
  r.structuredContent as {
    source: { dataset: string; vintage: string }
    query: { dataset: string; year: number; product: string | null }
    caveats: { code: string; message: string }[]
  }
const productCaveat = (r: Result) =>
  structured(r).caveats.find((c) => c.code === 'PRODUCT_SELECTED')

const validate = new Ajv({ strict: false }).compile(
  FetchAggregateDataOutputSchema,
)

describe('fetch-aggregate-data product selection', () => {
  let tool: FetchAggregateDataTool

  beforeEach(() => {
    ;(QueryCacheService.getInstance as Mock).mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    })
    mockFetch.mockReset()
    clearVariablesCache()
    tool = new FetchAggregateDataTool()
  })

  it('without product, queries the dataset exactly as given', async () => {
    route({})
    const r = await tool.toolHandler({ ...base, dataset: 'acs/acs1' }, 'k')
    expect(dataCalls()).toEqual(['2024/acs/acs1'])
    expect(productCaveat(r)).toBeUndefined()
    expect(structured(r).query.product).toBeNull()
  })

  describe('auto, one geography', () => {
    it('uses 1-year when it is published there, and says so first', async () => {
      route({})
      const r = await tool.toolHandler(
        { ...base, dataset: 'acs/acs5', product: 'auto' },
        'k',
      )
      expect(dataCalls()).toEqual(['2024/acs/acs1'])
      expect(structured(r).source.dataset).toBe('acs/acs1')
      expect(structured(r).caveats[0].code).toBe('PRODUCT_SELECTED')
      expect(productCaveat(r)!.message).toMatch(/ACS 1-year 2024 .*65,000\+/)
      expect((r.content[0] as { text: string }).text).toMatch(
        /## Caveats\n\n\*\*ACS PRODUCT:\*\* ACS 1-year 2024/,
      )
      expect(validate(r.structuredContent)).toBe(true)
    })

    it('falls back to 5-year when 1-year has no data (HTTP 204, area under 65,000)', async () => {
      route({ '2024/acs/acs1': 204 })
      const r = await tool.toolHandler(
        { ...base, dataset: 'acs/acs1', product: 'auto' },
        'k',
      )
      expect(r.isError).toBeFalsy()
      expect(dataCalls()).toEqual(['2024/acs/acs1', '2024/acs/acs5'])
      expect(structured(r).source.dataset).toBe('acs/acs5')
      expect(structured(r).query).toMatchObject({
        dataset: 'acs/acs5',
        year: 2024,
        product: 'auto',
      })
      const msg = productCaveat(r)!.message
      expect(msg).toContain(
        'no ACS 1-year estimate is published for this geography',
      )
      expect(msg).toContain('covers 2020-2024')
      expect(validate(r.structuredContent)).toBe(true)
    })

    it('falls back to 5-year on a 1-year 400', async () => {
      route({ '2024/acs/acs1': 400 })
      const r = await tool.toolHandler(
        { ...base, dataset: 'acs/acs1', product: 'auto' },
        'k',
      )
      expect(dataCalls()).toEqual(['2024/acs/acs1', '2024/acs/acs5'])
      expect(productCaveat(r)!.message).toContain(
        'does not publish this geography',
      )
    })

    it('uses the latest 5-year vintage when the requested one is not out yet', async () => {
      route({ '2025/acs/acs1': 204, '2025/acs/acs5': 404 })
      const r = await tool.toolHandler(
        { ...base, year: 2025, dataset: 'acs/acs1', product: 'auto' },
        'k',
      )
      expect(dataCalls()).toEqual([
        '2025/acs/acs1',
        '2025/acs/acs5',
        '2024/acs/acs5',
      ])
      expect(structured(r).source.vintage).toBe('2024')
      const msg = productCaveat(r)!.message
      expect(msg).toContain('ACS 5-year 2025 is not published yet')
      expect(msg).toContain('covers 2020-2024')
    })

    it('handles a vintage with no 1-year release (2020)', async () => {
      route({ '2020/acs/acs1': 404 })
      const r = await tool.toolHandler(
        { ...base, year: 2020, dataset: 'acs/acs1', product: 'auto' },
        'k',
      )
      expect(dataCalls()).toEqual(['2020/acs/acs1', '2020/acs/acs5'])
      expect(productCaveat(r)!.message).toContain(
        'no standard 1-year release for 2020',
      )
    })

    it('does not mask a genuine upstream failure with a fallback', async () => {
      route({ '2024/acs/acs1': 503 })
      const r = await tool.toolHandler(
        { ...base, dataset: 'acs/acs1', product: 'auto' },
        'k',
      )
      expect(r.isError).toBe(true)
      expect(dataCalls()).toEqual(['2024/acs/acs1'])
    })

    it('keeps the table family: /subject stays /subject', async () => {
      route({ '2024/acs/acs1/subject': 204 })
      const r = await tool.toolHandler(
        { ...base, dataset: 'acs/acs5/subject', product: 'auto' },
        'k',
      )
      expect(dataCalls()).toEqual([
        '2024/acs/acs1/subject',
        '2024/acs/acs5/subject',
      ])
      expect(structured(r).source.dataset).toBe('acs/acs5/subject')
    })

    it('goes straight to 5-year for levels 1-year never publishes', async () => {
      route({})
      const r = await tool.toolHandler(
        {
          ...base,
          dataset: 'acs/acs1',
          product: 'auto',
          for: 'tract:000100',
          in: 'state:02+county:020',
        },
        'k',
      )
      expect(dataCalls()).toEqual(['2024/acs/acs5'])
      expect(productCaveat(r)!.message).toContain('never published for tract')
    })
  })

  describe('auto, several geographies', () => {
    it.each([
      ['a wildcard', { for: 'county:*', in: 'state:02' }],
      ['a comma list', { for: 'state:01,02', in: undefined }],
      ['a parent wildcard', { for: 'place:36400', in: 'state:*' }],
    ])('uses 5-year for %s, without trying 1-year', async (_label, geo) => {
      route({})
      const r = await tool.toolHandler(
        { ...base, ...geo, dataset: 'acs/acs1', product: 'auto' },
        'k',
      )
      expect(dataCalls()).toEqual(['2024/acs/acs5'])
      expect(productCaveat(r)!.message).toContain('covers several geographies')
    })
  })

  describe('forced products', () => {
    it('product="5-year" overrides an acs1 dataset', async () => {
      route({})
      const r = await tool.toolHandler(
        { ...base, dataset: 'acs/acs1', product: '5-year' },
        'k',
      )
      expect(dataCalls()).toEqual(['2024/acs/acs5'])
      expect(productCaveat(r)!.message).toMatch(
        /as requested .*covers 2020-2024/,
      )
    })

    it('product="1-year" overrides an acs5 dataset, with no fallback', async () => {
      route({ '2024/acs/acs1': 204 })
      const r = await tool.toolHandler(
        { ...base, dataset: 'acs/acs5', product: '1-year' },
        'k',
      )
      expect(dataCalls()).toEqual(['2024/acs/acs1'])
      expect(r.isError).toBe(true)
    })
  })

  it('rejects product for a dataset with no 1-year/5-year pair', async () => {
    route({})
    const r = await tool.toolHandler(
      { ...base, dataset: 'dec/pl', product: 'auto' },
      'k',
    )
    expect(r.isError).toBe(true)
    expect((r.content[0] as { text: string }).text).toContain(
      'only applies to ACS datasets',
    )
    expect(dataCalls()).toEqual([])
  })

  it('accepts product through the argument schema', () => {
    expect(
      tool.validateArgs({ ...base, dataset: 'acs/acs1', product: 'auto' })
        .success,
    ).toBe(true)
    expect(
      tool.validateArgs({ ...base, dataset: 'acs/acs1', product: 'sometimes' })
        .success,
    ).toBe(false)
  })
})

describe('acs-product helpers', () => {
  it.each([
    ['acs/acs1', { product: '1-year', suffix: '' }],
    ['acs/acs5/profile', { product: '5-year', suffix: '/profile' }],
    ['ACS/ACS1/Subject', { product: '1-year', suffix: '/subject' }],
    ['acs/acs1/spp', null],
    ['acs/acsse', null],
    ['dec/pl', null],
  ])('acsFamily(%s)', (dataset, expected) => {
    expect(acsFamily(dataset)).toEqual(expected)
  })

  it('isSingleGeography', () => {
    expect(isSingleGeography({ for: 'county:020', in: 'state:02' })).toBe(true)
    expect(isSingleGeography({ ucgid: '0500000US02020' })).toBe(true)
    expect(isSingleGeography({ for: 'county:*', in: 'state:02' })).toBe(false)
    expect(isSingleGeography({ ucgid: '0400000US02,0400000US06' })).toBe(false)
  })

  it('acs1Unpublished', () => {
    expect(acs1Unpublished('block group:1')).toBe(true)
    expect(acs1Unpublished('zip code tabulation area:99501')).toBe(true)
    expect(acs1Unpublished('county:020')).toBe(false)
    expect(acs1Unpublished(undefined)).toBe(false)
  })
})
