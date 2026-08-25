// Unit tests for the ported list-survey-programs tool and the
// list-survey-components tool that completes upstream PR #141's pair.
// Structured output is validated against the declared schemas on both
// the hit and the miss branches (the zero-result trap).
import Ajv from 'ajv'
import { describe, expect, it, vi, Mock } from 'vitest'

vi.mock('../../src/services/database.service.js', () => ({
  DatabaseService: {
    getInstance: vi.fn(),
  },
}))

import { DatabaseService } from '../../src/services/database.service.js'
import { ListSurveyProgramsTool } from '../../src/tools/list-survey-programs.tool'
import { ListSurveyComponentsTool } from '../../src/tools/list-survey-components.tool'
import { ListSurveyProgramsOutputSchema } from '../../src/schema/list-survey-programs.schema'
import { ListSurveyComponentsOutputSchema } from '../../src/schema/list-survey-components.schema'

const ajv = new Ajv({ allowUnionTypes: true })

function expectValid(schema: object, data: unknown): void {
  const validate = ajv.compile(schema)
  const ok = validate(data)
  expect(ok, JSON.stringify(validate.errors, null, 2) || 'valid').toBe(true)
}

function mockDb(rows: unknown[]): { query: Mock } {
  const dbMock = {
    healthCheck: vi.fn().mockResolvedValue(true),
    query: vi.fn().mockResolvedValue({ rows }),
  }
  ;(DatabaseService.getInstance as Mock).mockReturnValue(dbMock)
  return dbMock
}

const PROGRAM_ROWS = [
  {
    program_label: 'American Community Survey',
    program_string: 'ACS',
    description: 'Continuous survey pooled into 1- and 5-year estimates.',
    table_count: 27000,
  },
  {
    program_label: 'Economic Census',
    program_string: 'ECN',
    description: null,
    table_count: 0,
  },
]

const COMPONENT_ROWS = [
  {
    component_label: 'Detailed Tables 5-Year',
    component_string: 'ACSDT5Y',
    api_endpoint: 'acs/acs5',
    frequency: 'Annual',
    frequency_notes: null,
    vintage_start: 2009,
    vintage_end: 2023,
    has_gaps: false,
    table_count: 21000,
    description: 'The most geographically comprehensive ACS product.',
  },
  {
    component_label: 'Migration Flows',
    component_string: 'ACSFLOWS',
    api_endpoint: 'acs/flows',
    frequency: null,
    frequency_notes: null,
    vintage_start: null,
    vintage_end: null,
    has_gaps: null,
    table_count: 0,
    description: null,
  },
]

describe('list-survey-programs', () => {
  it('returns schema-valid structuredContent with a NO_INDEXED_TABLES caveat', async () => {
    mockDb(PROGRAM_ROWS)
    const tool = new ListSurveyProgramsTool()
    const result = await tool.handler({})
    expect(result.isError).toBeUndefined()
    expectValid(ListSurveyProgramsOutputSchema, result.structuredContent)
    const structured = result.structuredContent as {
      total_count: number
      records: { program_string: string }[]
      caveats: { code: string; message: string }[]
    }
    expect(structured.total_count).toBe(2)
    expect(structured.records[0].program_string).toBe('ACS')
    // One program has table_count 0 -> the false-zero caveat fires...
    expect(
      structured.caveats.some((c) => c.code === 'NO_INDEXED_TABLES'),
    ).toBe(true)
    // ...and every structured caveat message appears in the text.
    const text = (result.content[0] as { text: string }).text
    for (const caveat of structured.caveats) {
      expect(text).toContain(caveat.message)
    }
  })

  it('treats an empty programs table as a data problem, not an absence', async () => {
    mockDb([])
    const tool = new ListSurveyProgramsTool()
    const result = await tool.handler({})
    expect(result.isError).toBeUndefined()
    expectValid(ListSurveyProgramsOutputSchema, result.structuredContent)
    const structured = result.structuredContent as {
      total_count: number
      caveats: { code: string }[]
    }
    expect(structured.total_count).toBe(0)
    expect(structured.caveats.some((c) => c.code === 'NO_MATCH')).toBe(true)
  })
})

describe('list-survey-components', () => {
  it('returns schema-valid structuredContent with gap and index caveats', async () => {
    mockDb(COMPONENT_ROWS)
    const tool = new ListSurveyComponentsTool()
    const result = await tool.handler({ program_string: 'ACS' })
    expect(result.isError).toBeUndefined()
    expectValid(ListSurveyComponentsOutputSchema, result.structuredContent)
    const structured = result.structuredContent as {
      total_count: number
      records: { api_endpoint: string; has_gaps: boolean | null }[]
      caveats: { code: string; message: string }[]
    }
    expect(structured.total_count).toBe(2)
    expect(structured.records[0].api_endpoint).toBe('acs/acs5')
    // has_gaps null (no datasets linked) survives as null, not false.
    expect(structured.records[1].has_gaps).toBeNull()
    expect(
      structured.caveats.some((c) => c.code === 'NO_INDEXED_TABLES'),
    ).toBe(true)
    const text = (result.content[0] as { text: string }).text
    for (const caveat of structured.caveats) {
      expect(text).toContain(caveat.message)
    }
  })

  it('uppercases the acronym before matching', async () => {
    const dbMock = mockDb(COMPONENT_ROWS)
    const tool = new ListSurveyComponentsTool()
    await tool.handler({ program_string: 'acs' })
    expect(dbMock.query).toHaveBeenCalledWith(
      'SELECT * FROM list_survey_components($1)',
      ['ACS'],
    )
  })

  it('emits structuredContent on a miss with total_count 0 and NO_MATCH', async () => {
    mockDb([])
    const tool = new ListSurveyComponentsTool()
    const result = await tool.handler({ program_string: 'XYZZY' })
    expect(result.isError).toBeUndefined()
    expectValid(ListSurveyComponentsOutputSchema, result.structuredContent)
    const structured = result.structuredContent as {
      total_count: number
      records: unknown[]
      caveats: { code: string; message: string }[]
    }
    expect(structured.total_count).toBe(0)
    expect(structured.records).toEqual([])
    expect(structured.caveats.some((c) => c.code === 'NO_MATCH')).toBe(true)
    // The miss points at the tool that answers correctly.
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('list-survey-programs')
  })
})
