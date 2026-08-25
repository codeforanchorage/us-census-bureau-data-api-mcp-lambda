import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from 'vitest'
import { Client } from 'pg'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'

import { dbConfig } from '../../test-helpers/database-config'
import { YearSchema } from '../../../src/schema/year.schema'
import { YearsConfig } from '../../../src/seeds/configs/years.config'
import { SeedRunner } from '../../../src/seeds/scripts/seed-runner'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface YearRow extends z.infer<typeof YearSchema> {
  id: number
  created_at: Date
  updated_at: Date
}

describe('Years Config', () => {
  let runner: SeedRunner
  let client: Client
  let databaseUrl: string

  // Isolated per-run schema, same pattern as summary-levels.config.test.ts
  // and get-or-create-year.helper.test.ts: the public `years` table is
  // seeded and cleaned by most geography config test files, which vitest
  // runs in PARALLEL, so asserting an exact row count against the shared
  // table races (the idempotency test below read [] whenever another file
  // cleaned `years` between our seed and our SELECT).
  const testId = `${process.pid}_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`
  const testSchema = `test_schema_years_${testId}`

  beforeAll(async () => {
    // Initialize client once for the entire test suite
    client = new Client(dbConfig)
    await client.connect()

    // Create isolated test schema with the years table structure
    // (mirrors migration 1755190777124 + 1765999444982).
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${testSchema}`)
    await client.query(`SET search_path TO ${testSchema}`)
    await client.query(`
      CREATE TABLE years (
        id BIGSERIAL PRIMARY KEY,
        year INTEGER NOT NULL UNIQUE,
        import_geographies BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `)

    // Construct database URL for SeedRunner scoped to the test schema
    databaseUrl = `postgresql://${dbConfig.user}:${dbConfig.password}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}?options=-c%20search_path%3D${testSchema}`
  })

  afterAll(async () => {
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`)
    } catch (error) {
      console.log('Schema cleanup failed:', error)
    }
    await client.end()
  })

  beforeEach(async () => {
    // Create test fixtures directory
    const fixturesPath = path.join(__dirname, 'fixtures')
    try {
      await fs.mkdir(fixturesPath, { recursive: true })
    } catch {
      console.log('Directory already exists.')
    }

    runner = new SeedRunner(databaseUrl, fixturesPath)
    await runner.connect()

    await client.query('DELETE FROM years')
  })

  afterEach(async () => {
    await runner.disconnect()
  })

  it('should have valid configuration structure', () => {
    expect(YearsConfig).toBeDefined()
    expect(YearsConfig?.table).toBe('years')
    expect(YearsConfig?.dataPath).toBe('years')
    expect(YearsConfig?.conflictColumn).toBe('year')
    expect(YearsConfig?.beforeSeed).toBeDefined()
  })

  describe('beforeSeed logic', () => {
    it('should validate correct data structure', () => {
      expect(YearsConfig?.beforeSeed).toBeDefined()

      const validData = [
        {
          year: 2023,
        },
      ]

      // Mock client for validation testing
      const mockClient = {} as Client

      // Should not throw with valid data
      expect(() =>
        YearsConfig!.beforeSeed!(mockClient, validData),
      ).not.toThrow()
    })

    it('should reject invalid data structure', () => {
      expect(YearsConfig.beforeSeed).toBeDefined()

      const invalidData = [
        {
          year: '2023', // Invalid Type
        },
      ]

      const mockClient = {} as Client

      // Should throw with invalid data
      expect(() => YearsConfig!.beforeSeed!(mockClient, invalidData)).toThrow(
        /validation failed/i,
      )
    })

    it('should handle empty data array', () => {
      expect(YearsConfig?.beforeSeed).toBeDefined()

      const emptyData: unknown[] = []
      const mockClient = {} as Client

      // Should handle empty data gracefully
      expect(() =>
        YearsConfig!.beforeSeed!(mockClient, emptyData),
      ).not.toThrow()
    })

    it('should provide detailed validation error messages', () => {
      expect(YearsConfig?.beforeSeed).toBeDefined()

      const invalidData = [
        {
          year: '2023',
        },
      ]

      const mockClient = {} as Client

      try {
        YearsConfig!.beforeSeed!(mockClient, invalidData)
        fail('Expected validation to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('validation failed')
      }
    })
  })

  // Integration tests for the complete seed workflow
  describe('complete seed workflow', () => {
    it('should handle idempotent seeding (skip existing records)', async () => {
      // Create test data
      const testYearsData = {
        years: [
          {
            year: 2023,
          },
          {
            year: 2020,
          },
        ],
      }

      const filePath = path.join(__dirname, 'fixtures', 'years_idempotent.json')
      await fs.writeFile(filePath, JSON.stringify(testYearsData))

      const seedConfig = {
        file: 'years_idempotent.json',
        table: 'years',
        conflictColumn: 'year',
        dataPath: 'years',
      }

      // Run seed twice
      await runner.seed(seedConfig)
      await runner.seed(seedConfig)

      // Should still have only 2 records (not duplicated)
      const result = await client.query<YearRow>(
        'SELECT * FROM years ORDER BY year',
      )
      expect(result.rows).toHaveLength(2)

      // Verify the records are correct
      const year1 = result.rows.find((row) => row.year === 2023)
      const year2 = result.rows.find((row) => row.year === 2020)

      expect(year1?.year).toBe(2023)
      expect(year2?.year).toBe(2020)
    })
  })
})
