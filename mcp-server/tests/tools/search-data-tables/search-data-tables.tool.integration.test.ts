import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest'
import Ajv from 'ajv'
import { Client } from 'pg'

import { DatabaseService } from '../../../src/services/database.service'
import { databaseConfig } from '../../helpers/database-config'
import { SearchDataTablesTool } from '../../../src/tools/search-data-tables.tool'
import { SearchDataTablesOutputSchema } from '../../../src/schema/search-data-tables.schema'
import { ToolResponse } from '../../../src/types/base.types'

type TableRecord = {
  data_table_id: string
  label: string
  component: string | null
  datasets: { year: string; endpoints: string[] }[]
}
type Structured = {
  total_count: number | null
  shown_count: number
  records: TableRecord[]
  caveats: { code: string; message: string }[]
}

const validate = new Ajv({ allowUnionTypes: true }).compile(
  SearchDataTablesOutputSchema,
)

// Assert on structuredContent -- the binding, schema-validated contract --
// rather than the rendered prose, which is presentation and changes shape.
function structured(response: ToolResponse): Structured {
  expect(response.isError).toBeUndefined()
  expect(
    validate(response.structuredContent),
    JSON.stringify(validate.errors),
  ).toBe(true)
  return response.structuredContent as Structured
}

function getResponseText(response: ToolResponse): string {
  const item = response.content[0]
  if (item.type !== 'text') {
    throw new Error(`Expected text content, got "${item.type}"`)
  }
  return (item as { type: 'text'; text: string }).text
}

function tableIds(s: Structured): string[] {
  return s.records.map((r) => r.data_table_id).sort()
}

function yearsOf(record: TableRecord): Record<string, string[]> {
  return Object.fromEntries(record.datasets.map((d) => [d.year, d.endpoints]))
}

describe('SearchDataTablesTool - Integration Tests', () => {
  let testClient: Client
  let databaseService: DatabaseService
  let tool: SearchDataTablesTool

  beforeAll(async () => {
    testClient = new Client(databaseConfig)
    await testClient.connect()
    ;(DatabaseService as unknown as { instance: unknown }).instance = undefined
    databaseService = DatabaseService.getInstance()
  })

  afterAll(async () => {
    await testClient.end()
    await databaseService.cleanup()
  })

  afterEach(async () => {
    await testClient.query('DELETE FROM data_table_datasets WHERE true')
    await testClient.query('DELETE FROM data_tables WHERE true')
    await testClient.query('DELETE FROM datasets WHERE true')
    await testClient.query('DELETE FROM years WHERE true')
    await testClient.query('DELETE FROM components WHERE true')
    await testClient.query('DELETE FROM programs WHERE true')

    await testClient.query(
      'ALTER SEQUENCE IF EXISTS data_table_datasets_id_seq RESTART WITH 1',
    )
    await testClient.query(
      'ALTER SEQUENCE IF EXISTS data_tables_id_seq RESTART WITH 1',
    )
    await testClient.query(
      'ALTER SEQUENCE IF EXISTS datasets_id_seq RESTART WITH 1',
    )
    await testClient.query(
      'ALTER SEQUENCE IF EXISTS years_id_seq RESTART WITH 1',
    )
    await testClient.query(
      'ALTER SEQUENCE IF EXISTS components_id_seq RESTART WITH 1',
    )
    await testClient.query(
      'ALTER SEQUENCE IF EXISTS programs_id_seq RESTART WITH 1',
    )
  })

  beforeEach(async () => {
    tool = new SearchDataTablesTool()

    // Seed programs
    await testClient.query(`
      INSERT INTO programs (acronym, label)
      VALUES ('ACS', 'American Community Survey')
    `)

    // Seed components
    await testClient.query(`
      INSERT INTO components (label, api_endpoint, description, component_id, program_id)
      VALUES (
        'ACS 1-Year Supplemental Estimates',
        'acs/acs1',
        'ACS 1-Year Supplemental Estimates',
        'ACSSE',
        (SELECT id FROM programs WHERE acronym = 'ACS')
      )
    `)

    // Seed years
    await testClient.query(`
      INSERT INTO years (year)
      VALUES (2009), (2010), (2019)
    `)

    // Seed datasets
    await testClient.query(`
      INSERT INTO datasets (dataset_id, name, description, type, api_endpoint, year_id, component_id)
      VALUES
        ('ACSDTY2009', 'ACS 1-Year Detailed Tables', 'The American Community Survey (ACS) is a nationwide survey...', 'aggregate',
          'acs/acs1',
          (SELECT id FROM years WHERE year = 2009),
          (SELECT id FROM components WHERE api_endpoint = 'acs/acs1')),
        ('ACSDTY2010', 'ACS 1-Year Detailed Tables', 'The American Community Survey (ACS) is a nationwide survey...', 'aggregate',
          'acs/acs1',
          (SELECT id FROM years WHERE year = 2010),
          (SELECT id FROM components WHERE api_endpoint = 'acs/acs1')),
        ('ACSDTY2019', 'ACS 1-Year Detailed Tables', 'The American Community Survey (ACS) is a nationwide survey...', 'aggregate',
          'acs/acs1',
          (SELECT id FROM years WHERE year = 2019),
          (SELECT id FROM components WHERE api_endpoint = 'acs/acs1'))
    `)
    // Seed data_tables
    await testClient.query(`
      INSERT INTO data_tables (data_table_id, label)
      VALUES
        ('B16005',  'Nativity By Language Spoken At Home By Ability To Speak English'),
        ('B16005D', 'Nativity By Language Spoken At Home By Ability To Speak English'),
        ('B19001',  'Household Income In The Past 12 Months')
    `)

    // B16005
    await testClient.query(`
      INSERT INTO data_table_datasets (data_table_id, dataset_id, label)
      VALUES
        (
          (SELECT id FROM data_tables WHERE data_table_id = 'B16005'),
          (SELECT id FROM datasets    WHERE dataset_id   = 'ACSDTY2009'),
          'Nativity By Language Spoken At Home By Ability To Speak English'
        ),
        (
          (SELECT id FROM data_tables WHERE data_table_id = 'B16005'),
          (SELECT id FROM datasets    WHERE dataset_id   = 'ACSDTY2010'),
          'Nativity By Language Spoken At Home By Ability To Speak English'
        )
    `)

    // B16005D
    await testClient.query(`
      INSERT INTO data_table_datasets (data_table_id, dataset_id, label)
      VALUES
        (
          (SELECT id FROM data_tables WHERE data_table_id = 'B16005D'),
          (SELECT id FROM datasets    WHERE dataset_id   = 'ACSDTY2009'),
          'Nativity By Language Spoken At Home (Asian Alone)'
        ),
        (
          (SELECT id FROM data_tables WHERE data_table_id = 'B16005D'),
          (SELECT id FROM datasets    WHERE dataset_id   = 'ACSDTY2010'),
          'Nativity By Language Spoken At Home (Asian Alone)'
        )
    `)

    // B19001
    await testClient.query(`
      INSERT INTO data_table_datasets (data_table_id, dataset_id, label)
      VALUES
        (
          (SELECT id FROM data_tables WHERE data_table_id = 'B19001'),
          (SELECT id FROM datasets    WHERE dataset_id   = 'ACSDTY2019'),
          'Household Income In The Past 12 Months'
        )
    `)
  })

  it('returns the expected table when a full data_table_id is provided', async () => {
    const response = await tool.handler({ data_table_id: 'B19001' })
    const s = structured(response)

    expect(s.total_count).toBe(1)
    expect(s.records[0]).toMatchObject({
      data_table_id: 'B19001',
      label: 'Household Income In The Past 12 Months',
    })
    expect(getResponseText(response)).toContain('data_table_id: B19001')
  })

  it('returns all tables matching a data_table_id prefix', async () => {
    const s = structured(await tool.handler({ data_table_id: 'B16005' }))

    expect(tableIds(s)).toEqual(['B16005', 'B16005D'])
  })

  it('reports a known zero with NO_MATCH for an unknown data_table_id', async () => {
    const response = await tool.handler({ data_table_id: 'ZZZZZZ' })
    const s = structured(response)

    expect(s.total_count).toBe(0)
    expect(s.caveats.map((c) => c.code)).toEqual(['NO_MATCH'])
    expect(getResponseText(response)).toContain(
      'No data tables matched data_table_id "ZZZZZZ".',
    )
  })

  it('returns tables whose canonical label fuzzy-matches the query', async () => {
    const s = structured(
      await tool.handler({ label_query: 'language spoken at home' }),
    )

    expect(tableIds(s)).toEqual(['B16005', 'B16005D'])
  })

  it('returns tables matching an income label query', async () => {
    const s = structured(
      await tool.handler({ label_query: 'household income' }),
    )

    expect(tableIds(s)).toEqual(['B19001'])
    expect(s.records[0].label).toBe('Household Income In The Past 12 Months')
  })

  it('reports NO_MATCH for a label query with no similarity match', async () => {
    const response = await tool.handler({
      label_query: 'xyzzy nonexistent topic',
    })
    const s = structured(response)

    expect(s.total_count).toBe(0)
    expect(s.caveats.map((c) => c.code)).toEqual(['NO_MATCH'])
    expect(getResponseText(response)).toContain(
      'No data tables matched label_query "xyzzy nonexistent topic".',
    )
  })

  it('returns only tables belonging to the specified api_endpoint', async () => {
    const s = structured(await tool.handler({ api_endpoint: 'acs/acs1' }))

    expect(tableIds(s)).toEqual(['B16005', 'B16005D', 'B19001'])
  })

  it('reports NO_MATCH for an unknown api_endpoint', async () => {
    const response = await tool.handler({ api_endpoint: 'unknown/endpoint' })
    const s = structured(response)

    expect(s.total_count).toBe(0)
    expect(getResponseText(response)).toContain(
      'No data tables matched api_endpoint "unknown/endpoint".',
    )
  })

  it('reports NO_MATCH when the label matches but the api_endpoint filter excludes it', async () => {
    const s = structured(
      await tool.handler({
        label_query: 'household income',
        api_endpoint: 'dec/sf1',
      }),
    )

    expect(s.total_count).toBe(0)
    const message = s.caveats[0].message
    expect(message).toContain('label_query "household income"')
    expect(message).toContain('api_endpoint "dec/sf1"')
  })

  it('includes component and datasets map in each result', async () => {
    const s = structured(await tool.handler({ data_table_id: 'B19001' }))

    const table = s.records[0]
    expect(table.component).toBe(
      'American Community Survey - ACS 1-Year Supplemental Estimates',
    )
    expect(yearsOf(table)).toEqual({ '2019': ['acs/acs1'] })
  })

  it('aggregates datasets by year for the same component', async () => {
    const s = structured(await tool.handler({ data_table_id: 'B16005' }))

    const table = s.records.find((t) => t.data_table_id === 'B16005')!
    expect(yearsOf(table)).toEqual({
      '2009': ['acs/acs1'],
      '2010': ['acs/acs1'],
    })
  })

  it('groups orphan datasets by api_endpoint across multiple years', async () => {
    // Seed a data table and orphan datasets (no component) across multiple years
    await testClient.query(`
      INSERT INTO data_tables (data_table_id, label)
      VALUES ('ARTS01', 'Arts Participation')
    `)
    await testClient.query(`
      INSERT INTO datasets (dataset_id, name, description, type, api_endpoint, year_id, component_id)
      VALUES
        ('CPSARTS201302', 'CPS Arts Feb 2013', 'CPS Arts supplement', 'microdata',
          'cps/arts/feb',
          (SELECT id FROM years WHERE year = 2009),  -- reuse seeded year
          NULL),
        ('CPSARTS201402', 'CPS Arts Feb 2014', 'CPS Arts supplement', 'microdata',
          'cps/arts/feb',
          (SELECT id FROM years WHERE year = 2010),  -- reuse seeded year
          NULL)
    `)
    await testClient.query(`
      INSERT INTO data_table_datasets (data_table_id, dataset_id, label)
      VALUES
        (
          (SELECT id FROM data_tables WHERE data_table_id = 'ARTS01'),
          (SELECT id FROM datasets WHERE dataset_id = 'CPSARTS201302'),
          'Arts Participation Feb'
        ),
        (
          (SELECT id FROM data_tables WHERE data_table_id = 'ARTS01'),
          (SELECT id FROM datasets WHERE dataset_id = 'CPSARTS201402'),
          'Arts Participation Feb'
        )
    `)

    const s = structured(await tool.handler({ data_table_id: 'ARTS01' }))
    const table = s.records[0]

    // Component label falls back to api_endpoint for orphans
    expect(table.component).toBe('cps/arts/feb')
    // Each year maps to the orphan's api_endpoint
    expect(yearsOf(table)).toEqual({
      '2009': ['cps/arts/feb'],
      '2010': ['cps/arts/feb'],
    })
  })

  it('respects the limit parameter and flags the truncation', async () => {
    const s = structured(await tool.handler({ data_table_id: 'B', limit: 1 }))

    expect(s.shown_count).toBe(1)
    expect(s.records).toHaveLength(1)
    // A full page means more may exist: the total is unmeasured, not 1.
    expect(s.total_count).toBeNull()
    expect(s.caveats.map((c) => c.code)).toContain('TRUNCATED')
  })
})
