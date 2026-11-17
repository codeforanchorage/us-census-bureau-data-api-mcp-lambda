import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

import { DatabaseService } from '../../src/services/database.service'
import {
  CacheDuration,
  CacheDurationUnit,
  CacheQueryRequest,
  QueryCacheService,
} from '../../src/services/queryCache.service'
import { databaseConfig } from '../helpers/database-config'

// The cache statements are hand-written SQL (a data-modifying CTE and a
// windowed DELETE); the unit tests only see them as strings. These run them
// against real Postgres.

const duration = new CacheDuration(1, CacheDurationUnit.YEAR)
const DATA = [
  ['NAME', 'B01001_001E'],
  ['Alaska', '733391'],
]

function request(n: number): CacheQueryRequest {
  return {
    dataset: 'test/prune',
    group: null,
    year: 2000 + n,
    variables: ['B01001_001E'],
    geographySpec: JSON.stringify({ for: `state:${n}` }),
  }
}

describe('QueryCacheService (integration)', () => {
  let client: Client
  let cache: QueryCacheService
  let databaseService: DatabaseService

  const years = async () =>
    (
      await client.query<{ year: number }>(
        'SELECT year FROM census_data_cache ORDER BY year',
      )
    ).rows.map((r) => r.year)

  beforeAll(async () => {
    client = new Client(databaseConfig)
    await client.connect()
    // Integration files share one module registry (isolate: false) and each
    // closes the pool when it finishes, so start from a fresh instance.
    ;(DatabaseService as unknown as { instance: unknown }).instance = undefined
    databaseService = DatabaseService.getInstance()
    cache = new QueryCacheService(databaseService)
  })

  afterAll(async () => {
    await client.query('DELETE FROM census_data_cache')
    await client.end()
    await databaseService.cleanup()
  })

  beforeEach(async () => {
    await client.query('DELETE FROM census_data_cache')
  })

  it('round-trips a response and misses on a different request', async () => {
    await cache.set(request(1), DATA, duration)
    expect(await cache.get(request(1))).toEqual(DATA)
    expect(await cache.get(request(2))).toBeNull()
  })

  it('does not return an expired row', async () => {
    await cache.set(request(1), DATA, duration)
    await client.query(
      "UPDATE census_data_cache SET expires_at = NOW() - INTERVAL '1 minute'",
    )
    expect(await cache.get(request(1))).toBeNull()
  })

  it('refreshes a stale last_accessed on a hit and leaves a fresh one alone', async () => {
    await cache.set(request(1), DATA, duration)
    await cache.set(request(2), DATA, duration)
    await client.query(
      "UPDATE census_data_cache SET last_accessed = NOW() - INTERVAL '3 days' WHERE year = 2001",
    )
    await client.query(
      "UPDATE census_data_cache SET last_accessed = NOW() - INTERVAL '2 hours' WHERE year = 2002",
    )

    expect(await cache.get(request(1))).toEqual(DATA)
    expect(await cache.get(request(2))).toEqual(DATA)

    const { rows } = await client.query<{ year: number; age_s: string }>(
      'SELECT year, EXTRACT(EPOCH FROM NOW() - last_accessed) AS age_s FROM census_data_cache ORDER BY year',
    )
    expect(Number(rows[0].age_s)).toBeLessThan(60) // was 3 days: touched
    expect(Number(rows[1].age_s)).toBeGreaterThan(3600) // 2 hours: left alone
  })

  it('prunes expired rows and the least recently used beyond the budget', async () => {
    for (const n of [1, 2, 3, 4]) await cache.set(request(n), DATA, duration)
    // 1 expired; of the rest, 4 is the most recently used, then 3, then 2.
    await client.query(
      "UPDATE census_data_cache SET expires_at = NOW() - INTERVAL '1 minute' WHERE year = 2001",
    )
    for (const [year, age] of [
      [2002, '3 days'],
      [2003, '2 days'],
      [2004, '1 day'],
    ]) {
      await client.query(
        `UPDATE census_data_cache SET last_accessed = NOW() - INTERVAL '${age}' WHERE year = $1`,
        [year],
      )
    }
    const { rows } = await client.query<{ size: number }>(
      'SELECT pg_column_size(response_data) AS size FROM census_data_cache LIMIT 1',
    )

    // Room for exactly two rows.
    const result = await cache.prune(rows[0].size * 2)

    expect(result).toEqual({ expired: 1, evicted: 1 })
    expect(await years()).toEqual([2003, 2004])
  })

  it('removes nothing while the cache is within its budget', async () => {
    for (const n of [1, 2, 3]) await cache.set(request(n), DATA, duration)
    expect(await cache.prune()).toEqual({ expired: 0, evicted: 0 })
    expect(await years()).toEqual([2001, 2002, 2003])
  })
})
