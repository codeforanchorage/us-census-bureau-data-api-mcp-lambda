// Validates ACTUAL tool output against the DECLARED outputSchema on the
// awkward branches -- a declared outputSchema is binding, and the branches
// most likely to break it (zero results, sentinel values, missing MOE,
// truncation, non-numeric cells) are invisible to happy-path tests.
import Ajv from 'ajv'
import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(function () {
    return {}
  }),
  Client: vi.fn().mockImplementation(function () {
    return {}
  }),
}))

import {
  buildStructuredRecords,
  formatAggregateResponse,
} from '../src/helpers/response-format'
import { FetchAggregateDataOutputSchema } from '../src/schema/fetch-aggregate-data.schema'
import { ResolveGeographyFipsOutputSchema } from '../src/schema/resolve-geography-fips.schema'
import { SearchDataTablesOutputSchema } from '../src/schema/search-data-tables.schema'
import { ListDatasetsOutputSchema } from '../src/schema/list-datasets.schema'
import { FetchDatasetGeographyOutputSchema } from '../src/schema/dataset-geography.schema'
import type { VariablesIndex } from '../src/helpers/variables-cache'
import type { ToolCaveat } from '../src/types/base.types'

const ajv = new Ajv({ allowUnionTypes: true })

function validateOrThrow(schema: object, data: unknown): void {
  const validate = ajv.compile(schema)
  if (!validate(data)) {
    throw new Error(
      `structuredContent violates declared outputSchema:\n${JSON.stringify(validate.errors, null, 2)}\n\ndata: ${JSON.stringify(data, null, 2)}`,
    )
  }
}

function makeIndex(): VariablesIndex {
  const byName = new Map([
    [
      'B25001_001E',
      {
        name: 'B25001_001E',
        label: 'Estimate!!Total housing units',
        moePair: 'B25001_001M',
      },
    ],
    [
      'B25001_001M',
      { name: 'B25001_001M', label: 'Margin of Error!!Total housing units' },
    ],
    ['NAME', { name: 'NAME', label: 'Geographic Area Name' }],
    ['GEO_ID', { name: 'GEO_ID', label: 'Geography' }],
  ])
  return {
    byName,
    estimateNames: ['B25001_001E'],
    groupNames: new Set(['B25001']),
  }
}

function aggregateInput(
  overrides: Partial<Parameters<typeof formatAggregateResponse>[0]> = {},
) {
  return {
    dataset: 'acs/acs5',
    year: 2023,
    url: 'https://api.census.gov/data/2023/acs/acs5?get=x&key=SECRET',
    headers: ['NAME', 'GEO_ID', 'B25001_001E', 'B25001_001M', 'state'],
    rows: [['Alaska', '0400000US02', '300000', '1500', '02']],
    queryEcho: 'get=..., dataset=acs/acs5, year=2023',
    queryParams: {
      dataset: 'acs/acs5',
      year: 2023,
      get: 'NAME,B25001_001E,B25001_001M',
      for: 'state:02',
      in: null,
      ucgid: null,
      predicates: null,
    },
    requestedVariables: ['B25001_001E'],
    autoAddedMoeFields: ['B25001_001M'],
    variablesIndex: makeIndex(),
    currentYear: 2026,
    ...overrides,
  }
}

describe('fetch-aggregate-data structured output', () => {
  it('conforms on the ordinary single-geography branch', () => {
    const { structured } = formatAggregateResponse(aggregateInput())
    validateOrThrow(FetchAggregateDataOutputSchema, structured)
    expect(structured.total_count).toBe(1)
    expect(structured.shown_count).toBe(1)
  })

  it('never emits a sentinel as a number: value null + annotation code', () => {
    const { structured, text } = formatAggregateResponse(
      aggregateInput({
        rows: [['Alaska', '0400000US02', '-666666666', '-888888888', '02']],
      }),
    )
    validateOrThrow(FetchAggregateDataOutputSchema, structured)
    const records = structured.records as {
      cells: Record<string, unknown>[]
    }[]
    const cell = records[0].cells.find((c) => c.variable === 'B25001_001E')!
    expect(cell.value).toBeNull()
    expect(cell.annotation).toBe('NOT_APPLICABLE')
    expect(cell.moe).toBeNull()
    expect(cell.moe_annotation).toBe('NO_MOE_DISPLAYED')
    // The text channel decodes the same sentinel -- both channels agree.
    expect(text).toContain('NOT_APPLICABLE')
    // The raw jam value appears nowhere as a bare number in the
    // structured channel.
    expect(JSON.stringify(structured.records)).not.toContain('-666666666')
  })

  it('keeps FIPS codes and GEO_ID as strings (leading zeros survive)', () => {
    const { structured } = formatAggregateResponse(aggregateInput())
    const records = structured.records as {
      geography: { codes: { level: string; code: string }[] }
      cells: Record<string, unknown>[]
    }[]
    const stateCode = records[0].geography.codes.find(
      (c) => c.level === 'state',
    )!
    expect(stateCode.code).toBe('02')
    const geoId = records[0].cells.find((c) => c.variable === 'GEO_ID')!
    expect(geoId.value).toBe('0400000US02')
  })

  it('admits negative estimates (no minimum anywhere)', () => {
    const { structured } = formatAggregateResponse(
      aggregateInput({
        rows: [['Alaska', '0400000US02', '-12345', '600', '02']],
      }),
    )
    validateOrThrow(FetchAggregateDataOutputSchema, structured)
    const records = structured.records as {
      cells: Record<string, unknown>[]
    }[]
    expect(
      records[0].cells.find((c) => c.variable === 'B25001_001E')!.value,
    ).toBe(-12345)
  })

  it('flags low reliability in the structured cell like the text does', () => {
    const { structured, text } = formatAggregateResponse(
      aggregateInput({
        // CV = (900/1.645)/1000 = 54.7% > 30%
        rows: [['Alaska', '0400000US02', '1000', '900', '02']],
      }),
    )
    validateOrThrow(FetchAggregateDataOutputSchema, structured)
    const records = structured.records as {
      cells: Record<string, unknown>[]
    }[]
    const cell = records[0].cells.find((c) => c.variable === 'B25001_001E')!
    expect(cell.low_reliability).toBe(true)
    expect(cell.cv_percent).toBe(55)
    expect(text).toContain('LOW RELIABILITY')
    const caveats = structured.caveats as ToolCaveat[]
    expect(caveats.some((c) => c.code === 'LOW_RELIABILITY')).toBe(true)
  })

  it('conforms on a truncated result and carries both counts', () => {
    const manyRows = Array.from({ length: 130 }, (_, i) => [
      `Place ${i}`,
      `0400000US${String(i).padStart(2, '0')}`,
      '100',
      '10',
      String(i).padStart(2, '0'),
    ])
    const { structured } = formatAggregateResponse(
      aggregateInput({ rows: manyRows }),
    )
    validateOrThrow(FetchAggregateDataOutputSchema, structured)
    expect(structured.total_count).toBe(130)
    expect(structured.shown_count).toBe(100)
    const caveats = structured.caveats as ToolCaveat[]
    expect(caveats.some((c) => c.code === 'TRUNCATED')).toBe(true)
  })

  it('redacts the API key in the structured citation_url', () => {
    const { structured } = formatAggregateResponse(aggregateInput())
    const source = structured.source as { citation_url: string }
    expect(source.citation_url).toContain('key=REDACTED')
    expect(JSON.stringify(structured)).not.toContain('SECRET')
  })

  it('every structured caveat message appears in the rendered text', () => {
    const { structured, text } = formatAggregateResponse(
      aggregateInput({
        // stale vintage + sentinel + auto-paired MOE + single unit all at once
        year: 2019,
        rows: [['Alaska', '0400000US02', '-666666666', '1500', '02']],
      }),
    )
    const caveats = structured.caveats as ToolCaveat[]
    expect(caveats.length).toBeGreaterThanOrEqual(3)
    for (const caveat of caveats) {
      expect(text).toContain(caveat.message)
    }
  })

  it('handles a variables catalog miss (null index) without violating the schema', () => {
    const { structured } = formatAggregateResponse(
      aggregateInput({ variablesIndex: null }),
    )
    validateOrThrow(FetchAggregateDataOutputSchema, structured)
    const variables = structured.variables as { label: string | null }[]
    expect(variables.every((v) => v.label === null)).toBe(true)
  })
})

describe('buildStructuredRecords edge cases', () => {
  it('treats empty-string cells as null values, not zero', () => {
    const { records } = buildStructuredRecords({
      headers: ['NAME', 'B25001_001E', 'state'],
      rows: [['Nowhere', '', '02']],
      variablesIndex: makeIndex(),
      cvFlagThreshold: 0.3,
    })
    expect(records[0].cells).toEqual([
      { variable: 'B25001_001E', value: null, annotation: null },
    ])
  })
})

describe('resolve-geography-fips structured output schema', () => {
  // The tool's formatter is private; validate representative payloads the
  // tool emits (mirrored from its construction sites) against the schema.
  it('conforms on a hit with caveats', () => {
    validateOrThrow(ResolveGeographyFipsOutputSchema, {
      query: {
        geography_name: 'Anchorage',
        summary_level_requested: 'Place',
        summary_level_resolved: null,
      },
      total_count: 30,
      shown_count: 25,
      records: [
        {
          name: 'Anchorage municipality, Alaska',
          summary_level: 'County',
          for: 'county:020',
          in: 'state:02',
          latitude: 61.17,
          longitude: -149.28,
        },
      ],
      caveats: [
        { code: 'TRUNCATED', message: 'matched 30; showing 25.' },
        { code: 'SUMMARY_LEVEL_IGNORED', message: 'ignored.' },
      ],
    })
  })

  it('conforms on the zero-match branch (total_count 0, not null)', () => {
    validateOrThrow(ResolveGeographyFipsOutputSchema, {
      query: {
        geography_name: 'Xyzzy',
        summary_level_requested: null,
        summary_level_resolved: null,
      },
      total_count: 0,
      shown_count: 0,
      records: [],
      caveats: [{ code: 'NO_MATCH', message: 'No geographies matched.' }],
    })
  })
})

describe('search-data-tables structured output schema', () => {
  it('conforms with total_count null when the limit was hit (unmeasured)', () => {
    validateOrThrow(SearchDataTablesOutputSchema, {
      query: {
        data_table_id: null,
        label_query: 'housing',
        api_endpoint: 'acs/acs5',
        limit: 20,
      },
      total_count: null,
      shown_count: 20,
      records: [
        {
          data_table_id: 'B25001',
          label: 'Housing Units',
          component: null,
          datasets: [{ year: '2023', endpoints: ['acs/acs5'] }],
        },
      ],
      caveats: [{ code: 'TRUNCATED', message: 'returned 20 (the limit).' }],
    })
  })

  it('conforms on the zero-match branch (total_count 0)', () => {
    validateOrThrow(SearchDataTablesOutputSchema, {
      query: {
        data_table_id: 'ZZZZZ',
        label_query: null,
        api_endpoint: null,
        limit: 20,
      },
      total_count: 0,
      shown_count: 0,
      records: [],
      caveats: [{ code: 'NO_MATCH', message: 'No data tables matched.' }],
    })
  })
})

describe('list-datasets structured output schema', () => {
  it('conforms, including a dataset with no vintage axis', () => {
    validateOrThrow(ListDatasetsOutputSchema, {
      query: { query: null, dataset: null },
      catalog_count: 2,
      total_count: 2,
      datasets: [
        {
          dataset: 'acs/acs5',
          title: 'American Community Survey 5-Year',
          years: [2019, 2023],
        },
        { dataset: 'surname', title: 'Surnames', years: [] },
      ],
      caveats: [],
    })
  })
})

describe('fetch-dataset-geography structured output schema', () => {
  it('conforms on a normal level list and on zero levels', () => {
    validateOrThrow(FetchDatasetGeographyOutputSchema, {
      query: { dataset: 'acs/acs5', year: 2023 },
      total_count: 1,
      levels: [
        {
          vintage: '2023-01-01',
          displayName: 'State',
          querySyntax: 'state',
          code: '040',
          name: 'state',
          hierarchy: ['state'],
          fullName: 'State',
          onSpine: true,
          queryExample: 'for=state:*',
          allowsWildcard: true,
        },
      ],
      caveats: [],
    })
    validateOrThrow(FetchDatasetGeographyOutputSchema, {
      query: { dataset: 'timeseries/x', year: null },
      total_count: 0,
      levels: [],
      caveats: [{ code: 'NO_GEOGRAPHY_LEVELS', message: 'none.' }],
    })
  })
})
