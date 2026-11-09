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

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest'
import Ajv from 'ajv'
import { QueryCacheService } from '../../../src/services/queryCache.service'
import { clearVariablesCache } from '../../../src/helpers/variables-cache'
import {
  GetIndicatorTool,
  clearLatestVintageCache,
} from '../../../src/tools/get-indicator.tool'
import { GetIndicatorOutputSchema } from '../../../src/schema/get-indicator.schema'
import { INDICATORS, INDICATOR_IDS } from '../../../src/helpers/indicators'

// Labels as published, captured from the live variables endpoints
// (2026-11-08). The right statistic must match; the reused-code traps must
// not.
const PUBLISHED: Record<string, { ok: string[]; wrong?: string[] }> = {
  population: { ok: ['Estimate!!Total'] },
  median_age: {
    ok: [
      'Estimate!!Median age!!Total',
      'Estimate!!Median age --!!Total:',
      'Estimate!!Median age --!!Total',
    ],
  },
  median_household_income: {
    ok: [
      'Estimate!!Median household income in the past 12 months (in 2014 Inflation-adjusted dollars)',
      'Estimate!!Median household income in the past 12 months (in 2025 inflation-adjusted dollars)',
    ],
  },
  per_capita_income: {
    ok: [
      'Estimate!!Per capita income in the past 12 months (in 2024 inflation-adjusted dollars)',
    ],
  },
  poverty_rate: {
    ok: [
      'Percent below poverty level!!Estimate!!Population for whom poverty status is determined',
      'Estimate!!Percent below poverty level!!Population for whom poverty status is determined',
    ],
  },
  unemployment_rate: {
    ok: [
      'Unemployment rate!!Estimate!!Population 16 years and over',
      'Estimate!!Unemployment rate!!Population 16 years and over',
    ],
  },
  bachelors_or_higher: {
    ok: [
      "Percent!!Estimate!!Percent bachelor's degree or higher",
      "Estimate!!Percent!!AGE BY EDUCATIONAL ATTAINMENT!!Population 25 years and over!!Bachelor's degree or higher",
      "Estimate!!Percent!!Population 25 years and over!!Percent bachelor's degree or higher",
    ],
    wrong: ["Male!!Estimate!!Percent bachelor's degree or higher"],
  },
  uninsured_rate: {
    ok: [
      'Percent Uninsured!!Estimate!!Civilian noninstitutionalized population',
      'Estimate!!Percent Uninsured!!Civilian noninstitutionalized population',
    ],
    wrong: [
      'Percent Insured by  Coverage Type!!Estimate!!Total civilian noninstitutionalized population',
    ],
  },
  mean_commute_minutes: {
    ok: [
      'Estimate!!COMMUTING TO WORK!!Mean travel time to work (minutes)',
      'Estimate!!COMMUTING TO WORK!!Workers 16 years and over!!Mean travel time to work (minutes)',
    ],
  },
  median_gross_rent: { ok: ['Estimate!!Median gross rent'] },
  median_home_value: { ok: ['Estimate!!Median value (dollars)'] },
  owner_occupied_share: {
    ok: [
      'Percent!!HOUSING TENURE!!Occupied housing units!!Owner-occupied',
      'Percent Estimate!!HOUSING TENURE!!Occupied housing units!!Owner-occupied',
    ],
    wrong: [
      'Percent!!HOUSING TENURE!!Renter-occupied',
      'Percent!!HOUSING TENURE!!Occupied housing units!!Renter-occupied',
    ],
  },
  median_housing_cost: { ok: ['Estimate!!Median monthly housing costs'] },
  decennial_population: { ok: [' !!Total'] },
}

describe('indicator label patterns', () => {
  it('covers every indicator', () => {
    expect(Object.keys(PUBLISHED).sort()).toEqual([...INDICATOR_IDS].sort())
  })

  for (const id of INDICATOR_IDS) {
    it(`${id} accepts its published labels and refuses reused-code traps`, () => {
      const { ok, wrong = [] } = PUBLISHED[id]
      for (const label of ok)
        expect(INDICATORS[id].label.test(label), label).toBe(true)
      for (const label of wrong)
        expect(INDICATORS[id].label.test(label), label).toBe(false)
    })
  }
})

// --- tool behaviour ---------------------------------------------------------

const THIS_YEAR = new Date().getUTCFullYear()

type Routes = {
  // dataset metadata probe: "<year>/<dataset>" -> status
  probe?: Record<string, number>
  // data call status per "<year>/<dataset>" (default 200 with ROWS)
  data?: Record<string, number>
  // published label per "<year>/<dataset>" for the indicator variable
  label?: Record<string, string>
}

function route(variable: string, defaultLabel: string, r: Routes = {}) {
  mockFetch.mockImplementation((url: string) => {
    const m = /data\/(\d{4})\/([^?]+?)(\/variables\.json|\.json)?(\?|$)/.exec(
      url,
    )!
    const key = `${m[1]}/${m[2]}`
    if (m[3] === '.json') {
      return Promise.resolve(
        new Response('{}', { status: r.probe?.[key] ?? 200 }),
      )
    }
    if (m[3] === '/variables.json') {
      const moe = variable.slice(0, -1) + 'M'
      return Promise.resolve(
        new Response(
          JSON.stringify({
            variables: {
              [variable]: { label: r.label?.[key] ?? defaultLabel, group: 'X' },
              [moe]: { label: 'Margin of Error', group: 'X' },
              NAME: { label: 'Geographic Area Name', group: 'N/A' },
            },
          }),
          { status: 200 },
        ),
      )
    }
    const status = r.data?.[key] ?? 200
    if (status !== 200) {
      return Promise.resolve(
        new Response(status === 204 ? null : 'x', { status }),
      )
    }
    const moe = variable.slice(0, -1) + 'M'
    return Promise.resolve(
      new Response(
        JSON.stringify([
          [variable, moe, 'state', 'county'],
          ['101717', '6030', '02', '020'],
        ]),
        { status: 200 },
      ),
    )
  })
}

const dataCalls = () =>
  mockFetch.mock.calls
    .map(([u]) => String(u))
    .filter((u) => u.includes('?') && !u.includes('variables.json'))
    .map((u) => /data\/(\d{4}\/[^?]+)/.exec(u)![1])

type IndicatorSC = {
  indicator: { id: string; unit: string; variable: string }
  source: { dataset: string }
  query: { product: string | null }
  records: { cells: Record<string, unknown>[] }[]
  caveats: { code: string }[]
}

const validate = new Ajv({ strict: false }).compile(GetIndicatorOutputSchema)
const geo = { for: 'county:020', in: 'state:02' }

describe('GetIndicatorTool', () => {
  let tool: GetIndicatorTool

  beforeEach(() => {
    ;(QueryCacheService.getInstance as Mock).mockReturnValue({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    })
    mockFetch.mockReset()
    clearVariablesCache()
    clearLatestVintageCache()
    tool = new GetIndicatorTool()
  })

  afterEach(() => vi.restoreAllMocks())

  it('returns a verified indicator with the aggregate envelope', async () => {
    route('B19013_001E', PUBLISHED.median_household_income.ok[1])
    const r = await tool.toolHandler(
      { indicator: 'median_household_income', year: 2024, ...geo },
      'k',
    )
    expect(r.isError).toBeFalsy()
    const sc = r.structuredContent as IndicatorSC
    expect(sc.indicator).toMatchObject({
      id: 'median_household_income',
      unit: 'dollars',
      variable: 'B19013_001E',
    })
    expect(sc.source.dataset).toBe('acs/acs1')
    expect(sc.query.product).toBe('auto')
    expect(sc.records[0].cells[0]).toMatchObject({ value: 101717, moe: 6030 })
    expect(validate(sc)).toBe(true)
    const text = (r.content[0] as { text: string }).text
    expect(text.indexOf('## Caveats')).toBeLessThan(
      text.indexOf('## Indicator'),
    )
    expect(text.indexOf('## Indicator')).toBeLessThan(text.indexOf('## Source'))
  })

  it('uses the table family the indicator lives in (subject / profile)', async () => {
    route('S1701_C03_001E', PUBLISHED.poverty_rate.ok[1])
    await tool.toolHandler(
      { indicator: 'poverty_rate', year: 2024, ...geo },
      'k',
    )
    expect(dataCalls()).toEqual(['2024/acs/acs1/subject'])

    mockFetch.mockReset()
    clearVariablesCache()
    route('DP03_0025E', PUBLISHED.mean_commute_minutes.ok[1])
    await tool.toolHandler(
      { indicator: 'mean_commute_minutes', year: 2024, ...geo },
      'k',
    )
    expect(dataCalls()).toEqual(['2024/acs/acs1/profile'])
  })

  it('defaults the year to last calendar year when it is published', async () => {
    route('B01003_001E', 'Estimate!!Total')
    await tool.toolHandler({ indicator: 'population', ...geo }, 'k')
    expect(dataCalls()).toEqual([`${THIS_YEAR - 1}/acs/acs1`])
  })

  it('falls back to the year before when last year is not published yet', async () => {
    route('B01003_001E', 'Estimate!!Total', {
      probe: { [`${THIS_YEAR - 1}/acs/acs1`]: 404 },
    })
    await tool.toolHandler({ indicator: 'population', ...geo }, 'k')
    expect(dataCalls()).toEqual([`${THIS_YEAR - 2}/acs/acs1`])
  })

  it('probes the 5-year dataset when product is forced to 5-year', async () => {
    route('B01003_001E', 'Estimate!!Total', {
      probe: { [`${THIS_YEAR - 1}/acs/acs5`]: 404 },
    })
    await tool.toolHandler(
      { indicator: 'population', product: '5-year', ...geo },
      'k',
    )
    expect(dataCalls()).toEqual([`${THIS_YEAR - 2}/acs/acs5`])
  })

  it('refuses a cell whose published label is a different statistic', async () => {
    route('S1501_C02_015E', PUBLISHED.bachelors_or_higher.wrong![0])
    const r = await tool.toolHandler(
      { indicator: 'bachelors_or_higher', year: 2012, ...geo },
      'k',
    )
    expect(r.isError).toBe(true)
    expect((r.content[0] as { text: string }).text).toContain(
      'which is a different statistic',
    )
  })

  it('passes product selection through: a small area gets 5-year', async () => {
    route('B19013_001E', PUBLISHED.median_household_income.ok[1], {
      data: { '2024/acs/acs1': 204 },
    })
    const r = await tool.toolHandler(
      { indicator: 'median_household_income', year: 2024, ...geo },
      'k',
    )
    const sc = r.structuredContent as IndicatorSC
    expect(sc.source.dataset).toBe('acs/acs5')
    expect(sc.caveats[0].code).toBe('PRODUCT_SELECTED')
    expect(validate(sc)).toBe(true)
  })

  it('serves decennial_population from dec/dhc 2020 and rejects other years', async () => {
    route('P1_001N', ' !!Total')
    const r = await tool.toolHandler(
      { indicator: 'decennial_population', ...geo },
      'k',
    )
    expect(dataCalls()).toEqual(['2020/dec/dhc'])
    expect((r.structuredContent as IndicatorSC).indicator.unit).toBe('people')

    const bad = await tool.toolHandler(
      { indicator: 'decennial_population', year: 2010, ...geo },
      'k',
    )
    expect(bad.isError).toBe(true)
  })

  it('passes upstream errors through untouched', async () => {
    route('B01003_001E', 'Estimate!!Total', { data: { '2024/acs/acs1': 503 } })
    const r = await tool.toolHandler(
      { indicator: 'population', year: 2024, ...geo },
      'k',
    )
    expect(r.isError).toBe(true)
  })

  it('validates arguments', () => {
    expect(tool.validateArgs({ indicator: 'population', ...geo }).success).toBe(
      true,
    )
    expect(tool.validateArgs({ indicator: 'gdp', ...geo }).success).toBe(false)
    expect(tool.validateArgs({ indicator: 'population' }).success).toBe(false)
  })
})
