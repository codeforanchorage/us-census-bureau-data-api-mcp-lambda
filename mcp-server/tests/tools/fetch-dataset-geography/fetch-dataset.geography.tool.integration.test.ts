import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest'
import Ajv from 'ajv'
import { Client } from 'pg'
import { FetchDatasetGeographyTool } from '../../../src/tools/fetch-dataset-geography.tool.js'
import { DatabaseService } from '../../../src/services/database.service.js'
import { FetchDatasetGeographyOutputSchema } from '../../../src/schema/dataset-geography.schema.js'
import { ToolResponse } from '../../../src/types/base.types.js'
import { databaseConfig } from '../../helpers/database-config.js'
import { hasCensusApiKey, NEEDS_KEY } from '../../helpers/census-key.js'

// The tool fetches through node-fetch (via fetchWithTimeout), so mocking
// global.fetch has no effect. Route node-fetch through a switchable
// override instead: tests that set it get a canned Census response, and
// everything else still reaches the real api.census.gov.
const fetchOverride = vi.hoisted(() => ({
  impl: null as null | ((url: string) => Promise<unknown>),
}))
vi.mock('node-fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node-fetch')>()
  return {
    ...actual,
    default: (...args: Parameters<typeof actual.default>) =>
      fetchOverride.impl
        ? fetchOverride.impl(String(args[0]))
        : actual.default(...args),
  }
})

type GeographyFips = {
  name: string
  geoLevelDisplay: string
  referenceDate: string
  requires?: string[]
}

function mockCensusGeography(fips: GeographyFips[]): void {
  fetchOverride.impl = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ fips }),
  })
}

type Level = {
  code: string
  displayName: string
  querySyntax: string
  description?: string
  onSpine: boolean
  queryExample: string
}
type Structured = {
  total_count: number
  levels: Level[]
  caveats: { code: string; message: string }[]
}

const validate = new Ajv({ allowUnionTypes: true }).compile(
  FetchDatasetGeographyOutputSchema,
)

// Assert on structuredContent -- the binding, schema-validated contract --
// rather than slicing JSON out of the rendered prose.
function structured(response: ToolResponse): Structured {
  expect(response.isError, textOf(response)).toBeUndefined()
  expect(
    validate(response.structuredContent),
    JSON.stringify(validate.errors),
  ).toBe(true)
  return response.structuredContent as Structured
}

function textOf(response: ToolResponse): string {
  return (response.content[0] as { text: string }).text
}

function level(s: Structured, code: string): Level | undefined {
  return s.levels.find((l) => l.code === code)
}

describe('FetchDatasetGeographyTool - Integration Tests', () => {
  let testClient: Client
  let databaseService: DatabaseService
  let tool: FetchDatasetGeographyTool

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
    fetchOverride.impl = null
    // Clean up test data after each test
    await testClient.query('DELETE FROM summary_levels WHERE true')
    await testClient.query(
      'ALTER SEQUENCE IF EXISTS summary_levels_id_seq RESTART WITH 1',
    )
  })

  beforeEach(async () => {
    tool = new FetchDatasetGeographyTool()

    // Insert known test data
    await testClient.query(`
      INSERT INTO summary_levels (name, description, get_variable, query_name, on_spine, code, parent_summary_level)
      VALUES
        ('United States', 'United States total', 'NATION', 'us', true, '010', null),
        ('State', 'States and State equivalents', 'STATE', 'state', true, '040', '010'),
        ('County', 'Counties and county equivalents', 'COUNTY', 'county', true, '050', '040'),
        ('Congressional District', 'Congressional Districts', 'CD', 'congressional+district', true, '500', '040'),
        ('Urban Area', 'Urban Areas', 'URBAN_AREA', 'urban+area', false, '400', null)
    `)

    // Set up parent relationships
    await testClient.query(`
      UPDATE summary_levels
      SET parent_summary_level_id = (
        SELECT id FROM summary_levels parent
        WHERE parent.code = summary_levels.parent_summary_level
      )
      WHERE parent_summary_level IS NOT NULL;
    `)
  })

  describe('Real Database Integration', () => {
    it('should successfully connect to database and retrieve geography levels', async () => {
      expect(await databaseService.healthCheck()).toBe(true)

      const result = await databaseService.query(`
        SELECT name, query_name, code, on_spine, parent_summary_level
        FROM summary_levels
        ORDER BY code
      `)

      expect(result.rows).toHaveLength(5)
      expect(result.rows[0]).toMatchObject({
        name: 'United States',
        query_name: 'us',
        code: '010',
        on_spine: true,
        parent_summary_level: null,
      })
    })

    it('should return a clean, sanitized error when the database is unreachable', async () => {
      // Swap the singleton for one pointed at a dead database.
      await databaseService.cleanup()
      process.env.DATABASE_URL =
        'postgresql://invalid:invalid@localhost:9999/invalid'
      ;(
        DatabaseService as typeof DatabaseService & { instance: unknown }
      ).instance = undefined
      const brokenService = DatabaseService.getInstance()

      try {
        const response = await new FetchDatasetGeographyTool().toolHandler(
          { dataset: 'acs/acs1' },
          process.env.CENSUS_API_KEY,
        )

        expect(response.isError).toBe(true)
        // The driver error (host, port, credentials) never reaches the
        // caller -- DatabaseService sanitizes it to an actionable sentence.
        expect(textOf(response)).toBe(
          'Failed to fetch dataset geography levels: The database is temporarily unavailable. Retry after a short delay.',
        )
        expect(textOf(response)).not.toContain('9999')
      } finally {
        // Restore even when an assertion fails: a leaked broken singleton
        // cascades "database unavailable" into every later test and makes
        // afterAll end an already-ended pool.
        await brokenService.cleanup()
        process.env.DATABASE_URL = `postgresql://${databaseConfig.user}:${databaseConfig.password}@${databaseConfig.host}:${databaseConfig.port}/${databaseConfig.database}`
        ;(
          DatabaseService as typeof DatabaseService & { instance: unknown }
        ).instance = undefined
        databaseService = DatabaseService.getInstance()
      }
    })

    it('reports a dataset with no geography levels as a known zero, not an error', async () => {
      mockCensusGeography([])

      const response = await tool.toolHandler(
        { dataset: 'acs/acs1' },
        process.env.CENSUS_API_KEY,
      )
      const s = structured(response)

      expect(s.total_count).toBe(0)
      expect(s.levels).toEqual([])
      expect(s.caveats.map((c) => c.code)).toEqual(['NO_GEOGRAPHY_LEVELS'])
      expect(textOf(response)).toContain(s.caveats[0].message)
    })
  })

  describe.skipIf(!hasCensusApiKey)(
    `Real Census API Integration ${NEEDS_KEY}`,
    () => {
      it('should fetch real ACS geography metadata with database enhancement', async () => {
        const response = await tool.toolHandler(
          { dataset: 'acs/acs1', year: 2022 },
          process.env.CENSUS_API_KEY,
        )

        expect(textOf(response)).toContain(
          'Available geographies for acs/acs1 (2022)',
        )
        const s = structured(response)
        expect(s.total_count).toBeGreaterThan(0)

        // Levels seeded into summary_levels are enhanced from the database.
        expect(level(s, '010')).toMatchObject({
          displayName: 'United States',
          querySyntax: 'us',
          onSpine: true,
          description: 'United States total',
        })
        expect(level(s, '040')).toMatchObject({
          displayName: 'State',
          querySyntax: 'state',
          onSpine: true,
          queryExample: expect.stringContaining('for=state:*'),
        })
      }, 15000) // Extended timeout for real API calls

      it('should work with timeseries datasets', async () => {
        const response = await tool.toolHandler(
          { dataset: 'timeseries/healthins/sahie' },
          process.env.CENSUS_API_KEY,
        )

        expect(textOf(response)).toContain(
          'Available geographies for timeseries/healthins/sahie',
        )
        const s = structured(response)
        expect(Array.isArray(s.levels)).toBe(true)
      }, 15000)
    },
  )

  describe('Database-Driven Metadata Enhancement', () => {
    it('should use database values over API values when available', async () => {
      mockCensusGeography([
        { name: 'us', geoLevelDisplay: '010', referenceDate: '2022-01-01' },
        {
          name: 'state',
          geoLevelDisplay: '040',
          referenceDate: '2022-01-01',
          requires: ['us'],
        },
      ])

      const s = structured(
        await tool.toolHandler(
          { dataset: 'acs/acs1', year: 2022 },
          process.env.CENSUS_API_KEY,
        ),
      )

      expect(level(s, '010')).toMatchObject({
        displayName: 'United States', // From database, not API 'us'
        querySyntax: 'us', // From database query_name
        description: 'United States total', // From database
        onSpine: true, // From database
      })
      expect(level(s, '040')).toMatchObject({
        displayName: 'State', // From database, not API 'state'
        querySyntax: 'state', // From database query_name
        queryExample: 'for=state:*', // Built from database hierarchy
        onSpine: true, // From database
      })
    })

    it('should build correct hierarchical query examples', async () => {
      mockCensusGeography([
        { name: 'us', geoLevelDisplay: '010', referenceDate: '2022-01-01' },
        {
          name: 'state',
          geoLevelDisplay: '040',
          referenceDate: '2022-01-01',
          requires: ['us'],
        },
        {
          name: 'county',
          geoLevelDisplay: '050',
          referenceDate: '2022-01-01',
          requires: ['state'],
        },
        {
          name: 'congressional district',
          geoLevelDisplay: '500',
          referenceDate: '2022-01-01',
          requires: ['state'],
        },
      ])

      const s = structured(
        await tool.toolHandler(
          { dataset: 'acs/acs1', year: 2022 },
          process.env.CENSUS_API_KEY,
        ),
      )

      expect(level(s, '010')?.queryExample).toBe('for=us:*')
      expect(level(s, '040')?.queryExample).toBe('for=state:*')
      expect(level(s, '050')?.queryExample).toBe('for=county:*&in=state:*')
      expect(level(s, '500')?.queryExample).toBe(
        'for=congressional+district:*&in=state:*',
      )
    })

    it('should handle mixed on_spine values from database', async () => {
      mockCensusGeography([
        { name: 'us', geoLevelDisplay: '010', referenceDate: '2022-01-01' },
        {
          name: 'urban area',
          geoLevelDisplay: '400',
          referenceDate: '2022-01-01',
        },
      ])

      const s = structured(
        await tool.toolHandler(
          { dataset: 'acs/acs1', year: 2022 },
          process.env.CENSUS_API_KEY,
        ),
      )

      expect(level(s, '010')?.onSpine).toBe(true)
      // Urban Area is seeded with on_spine = false
      expect(level(s, '400')?.onSpine).toBe(false)
    })
  })
})
