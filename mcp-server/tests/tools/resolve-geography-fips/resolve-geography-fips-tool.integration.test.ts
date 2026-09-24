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
import { ResolveGeographyFipsTool } from '../../../src/tools/resolve-geography-fips.tool'
import { ResolveGeographyFipsOutputSchema } from '../../../src/schema/resolve-geography-fips.schema'
import { ToolResponse } from '../../../src/types/base.types'

type GeographyRecord = {
  name: string
  summary_level: string
  for: string
  in: string | null
}
type Structured = {
  total_count: number
  records: GeographyRecord[]
  caveats: { code: string; message: string }[]
}

const validate = new Ajv({ allowUnionTypes: true }).compile(
  ResolveGeographyFipsOutputSchema,
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

function text(response: ToolResponse): string {
  return (response.content[0] as { text: string }).text
}

function names(s: Structured): string[] {
  return s.records.map((r) => r.name).sort()
}

describe('ResolveGeographyFipsTool - Integration Tests', () => {
  let testClient: Client
  let databaseService: DatabaseService
  let tool: ResolveGeographyFipsTool

  beforeAll(async () => {
    // Use test database
    testClient = new Client(databaseConfig)
    await testClient.connect()
    ;(
      DatabaseService as typeof DatabaseService & { instance: unknown }
    ).instance = undefined
    databaseService = DatabaseService.getInstance()
  })

  afterAll(async () => {
    await testClient.end()
    await databaseService.cleanup()
  })

  afterEach(async () => {
    // Clean up in dependency order (children first), then reset sequences.
    await testClient.query('DELETE FROM geographies WHERE true')
    await testClient.query('DELETE FROM summary_levels WHERE true')
    await testClient.query(
      'ALTER SEQUENCE IF EXISTS geographies_id_seq RESTART WITH 1',
    )
    await testClient.query(
      'ALTER SEQUENCE IF EXISTS summary_levels_id_seq RESTART WITH 1',
    )
  })

  beforeEach(async () => {
    tool = new ResolveGeographyFipsTool()

    // Insert known test data
    await testClient.query(`
      INSERT INTO summary_levels (name, description, get_variable, query_name, on_spine, code, parent_summary_level)
      VALUES
        ('Nation', 'The United States', 'NATION', 'us', true, '010', null),
        ('State', 'States and State equivalents', 'STATE', 'state', true, '040', '030'),
        ('County', 'Counties and county equivalents', 'COUNTY', 'county', true, '050', '040'),
        ('Place', 'Census-designated places that meet population requirements', 'PLACE', 'place', false, '160', '040')
    `)

    await testClient.query(`
      INSERT INTO geographies (name, summary_level_code, ucgid_code, latitude, longitude, state_code, county_code, for_param, in_param)
      VALUES
        ('United States','010','0100000US','34.7366771','-103.2852703', null, null, 'us:*', null),
        ('Pennsylvania','040','0400000US42','40.5869403','-77.3684875', '42', null, 'state:42', null),
        ('Philadelphia County, Pennsylvania','050','0500000US42101','39.9525839','-75.1652215', '42', '101', 'county:101', 'state:42'),
        ('Philadelphia city, Pennsylvania','160','1600000US4260000','40.0093755','-75.1333459', '42', null, 'place:60000', 'state:42')
    `)
  })

  it('returns records carrying the for/in strings fetch-aggregate-data needs', async () => {
    const response = await tool.handler({ geography_name: 'Philadelphia' })
    const s = structured(response)

    expect(s.total_count).toBe(2)
    const city = s.records.find(
      (r) => r.name === 'Philadelphia city, Pennsylvania',
    )
    expect(city).toMatchObject({
      summary_level: 'Place',
      for: 'place:60000',
      in: 'state:42',
    })
    // The rendered text carries the same load-bearing fields.
    expect(text(response)).toContain('for: place:60000')
    expect(text(response)).toContain('in: state:42')
  })

  it('filters by summary level name', async () => {
    const s = structured(
      await tool.handler({
        geography_name: 'Philadelphia',
        summary_level: 'Place',
      }),
    )

    expect(names(s)).toEqual(['Philadelphia city, Pennsylvania'])
    expect(s.records[0].summary_level).toBe('Place')
  })

  it('returns only Counties when filtering by the County summary level', async () => {
    const s = structured(
      await tool.handler({
        geography_name: 'Philadelphia',
        summary_level: 'County',
      }),
    )

    expect(names(s)).toEqual(['Philadelphia County, Pennsylvania'])
    expect(s.records[0]).toMatchObject({
      summary_level: 'County',
      for: 'county:101',
      in: 'state:42',
    })
  })

  it('filters by summary level code', async () => {
    const s = structured(
      await tool.handler({
        geography_name: 'Philadelphia',
        summary_level: '160', // Place code
      }),
    )

    expect(names(s)).toEqual(['Philadelphia city, Pennsylvania'])
  })

  it('returns every matching level when no summary level filter is given', async () => {
    const s = structured(await tool.handler({ geography_name: 'Philadelphia' }))

    expect(names(s)).toEqual([
      'Philadelphia County, Pennsylvania',
      'Philadelphia city, Pennsylvania',
    ])
    expect(s.caveats).toEqual([])
  })

  it('reports a known zero with NO_MATCH when the summary level excludes everything', async () => {
    const response = await tool.handler({
      geography_name: 'Philadelphia',
      summary_level: 'State', // No States named Philadelphia
    })
    const s = structured(response)

    expect(s.total_count).toBe(0)
    expect(s.records).toEqual([])
    expect(s.caveats.map((c) => c.code)).toEqual(['NO_MATCH'])
    expect(text(response)).toContain(
      'No geographies matched "Philadelphia" at summary level "State".',
    )
  })
})
