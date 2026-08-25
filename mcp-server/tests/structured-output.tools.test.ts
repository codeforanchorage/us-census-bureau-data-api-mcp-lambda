// The zero-result trap: any branch that short-circuits with a "no
// results" string before the shared formatter would advertise an
// outputSchema and then return no structuredContent -- a conformance
// break invisible to happy-path tests. Pin structuredContent PRESENT and
// schema-valid on both a hit and a miss for the database-backed tools.
import Ajv from 'ajv'
import { describe, expect, it, vi, Mock } from 'vitest'

vi.mock('../src/services/database.service.js', () => ({
  DatabaseService: {
    getInstance: vi.fn(),
  },
}))

import { DatabaseService } from '../src/services/database.service.js'
import { ResolveGeographyFipsTool } from '../src/tools/resolve-geography-fips.tool'
import { SearchDataTablesTool } from '../src/tools/search-data-tables.tool'
import { ResolveGeographyFipsOutputSchema } from '../src/schema/resolve-geography-fips.schema'
import { SearchDataTablesOutputSchema } from '../src/schema/search-data-tables.schema'

const ajv = new Ajv({ allowUnionTypes: true })

function expectValid(schema: object, data: unknown): void {
  const validate = ajv.compile(schema)
  const ok = validate(data)
  expect(
    ok,
    JSON.stringify(validate.errors, null, 2) || 'valid',
  ).toBe(true)
}

function mockDb(rows: unknown[]): void {
  const dbMock = {
    healthCheck: vi.fn().mockResolvedValue(true),
    query: vi.fn().mockResolvedValue({ rows }),
  }
  ;(DatabaseService.getInstance as Mock).mockReturnValue(dbMock)
}

describe('resolve-geography-fips structuredContent', () => {
  it('is present and schema-valid on a hit', async () => {
    mockDb([
      {
        id: 1,
        name: 'Anchorage municipality, Alaska',
        summary_level_name: 'County',
        latitude: 61.17,
        longitude: -149.28,
        for_param: 'county:020',
        in_param: 'state:02',
        weighted_score: 1,
      },
    ])
    const tool = new ResolveGeographyFipsTool()
    const result = await tool.handler({ geography_name: 'Anchorage' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toBeDefined()
    expectValid(ResolveGeographyFipsOutputSchema, result.structuredContent)
    const structured = result.structuredContent as {
      total_count: number
      records: { for: string }[]
    }
    expect(structured.total_count).toBe(1)
    expect(structured.records[0].for).toBe('county:020')
  })

  it('is present and schema-valid on a miss, with total_count 0', async () => {
    mockDb([])
    const tool = new ResolveGeographyFipsTool()
    const result = await tool.handler({ geography_name: 'Xyzzy' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toBeDefined()
    expectValid(ResolveGeographyFipsOutputSchema, result.structuredContent)
    const structured = result.structuredContent as {
      total_count: number
      records: unknown[]
      caveats: { code: string; message: string }[]
    }
    expect(structured.total_count).toBe(0)
    expect(structured.records).toEqual([])
    expect(structured.caveats.some((c) => c.code === 'NO_MATCH')).toBe(true)
    // Every structured caveat message appears in the text channel too.
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('No geographies matched')
  })
})

describe('search-data-tables structuredContent', () => {
  it('is present and schema-valid on a hit', async () => {
    mockDb([
      {
        data_table_id: 'B25001',
        label: 'Housing Units',
        component: 'Housing',
        datasets: { '2023': ['acs/acs5'] },
      },
    ])
    const tool = new SearchDataTablesTool()
    const result = await tool.handler({ label_query: 'housing' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toBeDefined()
    expectValid(SearchDataTablesOutputSchema, result.structuredContent)
    const structured = result.structuredContent as {
      total_count: number | null
      records: { datasets: { year: string; endpoints: string[] }[] }[]
    }
    // One row against a limit of 20: the total is known, not unmeasured.
    expect(structured.total_count).toBe(1)
    expect(structured.records[0].datasets).toEqual([
      { year: '2023', endpoints: ['acs/acs5'] },
    ])
  })

  it('reports total_count null (unmeasured) when the limit was hit', async () => {
    mockDb(
      Array.from({ length: 3 }, (_, i) => ({
        data_table_id: `B2500${i}`,
        label: `Table ${i}`,
        component: null,
        datasets: {},
      })),
    )
    const tool = new SearchDataTablesTool()
    const result = await tool.handler({ label_query: 'housing', limit: 3 })
    expectValid(SearchDataTablesOutputSchema, result.structuredContent)
    const structured = result.structuredContent as {
      total_count: number | null
      caveats: { code: string }[]
    }
    expect(structured.total_count).toBeNull()
    expect(structured.caveats.some((c) => c.code === 'TRUNCATED')).toBe(true)
  })

  it('is present and schema-valid on a miss, with total_count 0', async () => {
    mockDb([])
    const tool = new SearchDataTablesTool()
    const result = await tool.handler({ label_query: 'zzzz' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toBeDefined()
    expectValid(SearchDataTablesOutputSchema, result.structuredContent)
    const structured = result.structuredContent as { total_count: number }
    expect(structured.total_count).toBe(0)
  })
})
