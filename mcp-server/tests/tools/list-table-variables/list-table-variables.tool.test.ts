const mockFetch = vi.fn()
vi.mock('node-fetch', () => ({ default: mockFetch }))

import Ajv from 'ajv'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearVariablesCache } from '../../../src/helpers/variables-cache'
import { ListTableVariablesOutputSchema } from '../../../src/schema/list-table-variables.schema'
import {
  ListTableVariablesTool,
  toolDescription,
} from '../../../src/tools/list-table-variables.tool'

// Mixes both catalog styles Census has published: recent vintages list the
// _M / _EA / _MA companions only as `attributes` of their estimate (B01001);
// older ones also list the _M as a top-level variable in the same group
// (B19013). Neither kind of companion may surface as a cell code.
const variablesJson = {
  variables: {
    NAME: { label: 'Geographic Area Name', group: 'N/A' },
    B01001_001E: {
      label: 'Estimate!!Total:',
      concept: 'Sex by Age',
      group: 'B01001',
      attributes: 'B01001_001M,B01001_001EA,B01001_001MA',
    },
    B01001_003E: {
      label: 'Estimate!!Total:!!Male:!!Under 5 years',
      concept: 'Sex by Age',
      group: 'B01001',
      attributes: 'B01001_003M,B01001_003EA,B01001_003MA',
    },
    B01001_002E: {
      label: 'Estimate!!Total:!!Male:',
      concept: 'Sex by Age',
      group: 'B01001',
      attributes: 'B01001_002M,B01001_002EA,B01001_002MA',
    },
    B19013_001E: {
      label: 'Estimate!!Median household income in the past 12 months',
      concept: 'Median Household Income',
      group: 'B19013',
    },
    B19013_001M: {
      label: 'Margin of Error!!Median household income in the past 12 months',
      concept: 'Median Household Income',
      group: 'B19013',
    },
  },
}

function wideTable(count: number) {
  const variables: Record<string, object> = {}
  for (let i = 1; i <= count; i++) {
    const code = `B99999_${String(i).padStart(3, '0')}E`
    variables[code] = {
      label: `Estimate!!Total:!!Row ${i}`,
      concept: 'Wide Table',
      group: 'B99999',
    }
  }
  return { variables }
}

function serve(body: unknown, status = 200) {
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

const ajv = new Ajv({ allowUnionTypes: true })
const validate = ajv.compile(ListTableVariablesOutputSchema)

type Structured = {
  concept: string | null
  table_variable_count: number
  total_count: number
  shown_count: number
  records: { code: string; label: string; has_moe: boolean }[]
  caveats: { code: string; message: string }[]
}

async function run(args: Record<string, unknown>) {
  const tool = new ListTableVariablesTool()
  const parsed = tool.argsSchema.parse({
    dataset: 'acs/acs5',
    year: 2023,
    ...args,
  })
  const result = await tool.toolHandler(parsed, 'KEY')
  return { result, structured: result.structuredContent as Structured }
}

afterEach(() => {
  clearVariablesCache()
  mockFetch.mockReset()
})

describe('ListTableVariablesTool', () => {
  it('is configured as a read-only, key-requiring tool', () => {
    const tool = new ListTableVariablesTool()
    expect(tool.name).toBe('list-table-variables')
    expect(tool.title).toBe('List Table Variables')
    expect(tool.description).toBe(toolDescription)
    expect(tool.requiresApiKey).toBe(true)
    expect(tool.inputSchema.required).toEqual(['dataset', 'year', 'table_id'])
  })

  it('lists estimate codes only, in code order, with pretty labels', async () => {
    serve(variablesJson)
    const { result, structured } = await run({ table_id: 'b01001' })

    expect(result.isError).toBeUndefined()
    expect(validate(structured)).toBe(true)
    expect(structured.concept).toBe('Sex by Age')
    expect(structured.records).toEqual([
      { code: 'B01001_001E', label: 'Total:', has_moe: true },
      { code: 'B01001_002E', label: 'Total: / Male:', has_moe: true },
      {
        code: 'B01001_003E',
        label: 'Total: / Male: / Under 5 years',
        has_moe: true,
      },
    ])
    expect(structured.table_variable_count).toBe(3)
    expect(structured.caveats).toEqual([])
    expect(result.content[0].text).toContain('code: B01001_002E')
    expect(result.content[0].text).toContain('get.group=B01001')
  })

  it('drops top-level MOE companions from older catalogs', async () => {
    serve(variablesJson)
    const { structured } = await run({ table_id: 'B19013' })
    expect(structured.records.map((r) => r.code)).toEqual(['B19013_001E'])
    expect(structured.records[0].has_moe).toBe(true)
  })

  it('narrows by label_filter, case-insensitively', async () => {
    serve(variablesJson)
    const { structured } = await run({
      table_id: 'B01001',
      label_filter: 'UNDER 5',
    })
    expect(structured.records.map((r) => r.code)).toEqual(['B01001_003E'])
    expect(structured.total_count).toBe(1)
    expect(structured.table_variable_count).toBe(3)
  })

  it('reports a filter miss as a schema-valid NO_MATCH, not an error', async () => {
    serve(variablesJson)
    const { result, structured } = await run({
      table_id: 'B01001',
      label_filter: 'nonexistent',
    })
    expect(result.isError).toBeUndefined()
    expect(validate(structured)).toBe(true)
    expect(structured.total_count).toBe(0)
    expect(structured.caveats.map((c) => c.code)).toEqual(['NO_MATCH'])
    expect(result.content[0].text).toContain(structured.caveats[0].message)
  })

  it('truncates at limit with a TRUNCATED caveat', async () => {
    serve(wideTable(30))
    const { structured } = await run({ table_id: 'B99999', limit: 5 })
    expect(structured.total_count).toBe(30)
    expect(structured.shown_count).toBe(5)
    expect(structured.caveats.map((c) => c.code)).toEqual(['TRUNCATED'])
  })

  it('switches to the compact fenced table above 20 records', async () => {
    serve(wideTable(30))
    const { result, structured } = await run({ table_id: 'B99999' })
    const text = result.content[0].text
    expect(structured.shown_count).toBe(30)
    expect(text).toContain('```\ncode | moe | label')
    expect(text).toContain('B99999_030E | no | Total: / Row 30')
    expect(text).not.toContain('Record 1:')
  })

  it('rejects an unknown table with a did-you-mean hint', async () => {
    serve(variablesJson)
    const { result } = await run({ table_id: 'B01002' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(result.content[0].text).toMatch(/not published in acs\/acs5 2023/)
    expect(result.content[0].text).toContain('Did you mean B01001')
  })

  it('errors cleanly when the dataset/vintage catalog is unavailable', async () => {
    serve({}, 404)
    const { result } = await run({ table_id: 'B01001', year: 1850 })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('list-datasets')
  })

  it('refuses microdata datasets before fetching anything', async () => {
    const { result } = await run({ dataset: 'acs/acs5/pums', table_id: 'X' })
    expect(result.isError).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
