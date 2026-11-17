// Ported from upstream PR #135
// (uscensusbureau/us-census-bureau-data-api-mcp). Caches Census API responses
// in the census_data_cache table, keyed by generate_cache_hash().

import { DatabaseService } from './database.service.js'

export enum CacheDurationUnit {
  YEAR = 'year',
  MONTH = 'month',
  DAY = 'day',
  HOUR = 'hour',
}

export class CacheDuration {
  constructor(
    public readonly n: number,
    public readonly unit: CacheDurationUnit,
  ) {
    if (!Number.isInteger(n)) {
      throw new Error(`Expected 'n' argument to be an integer but got ${n}.`)
    }
    if (n <= 0) {
      throw new Error(
        `Expected 'n' argument to be greater than zero but got ${n}.`,
      )
    }
  }

  toString() {
    return `${this.n} ${this.unit}`
  }
}

// Pruning. Nothing else removes rows from census_data_cache: entries live for
// a year and the table only grew. A warm container prunes at most once per
// PRUNE_INTERVAL_MS, after a write:
//   1. rows past their expiry are deleted;
//   2. if what remains holds more than CACHE_MAX_BYTES of response data, the
//      least recently used rows beyond that budget are deleted.
// The budget is measured on the stored (compressed) size of the live rows,
// not on the table's size on disk: deleted rows only free disk after a
// vacuum, so a disk-size test would stay over the limit and empty the cache.
export const CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000

// A hit refreshes last_accessed at most this often, so the least-recently-
// used ordering is real without turning every read into a write.
const TOUCH_INTERVAL = '1 day'

export interface CacheQueryRequest {
  dataset: string
  group: string | null
  year: string | number
  variables: string[]
  geographySpec: string
}

export class QueryCacheService {
  private static instance: QueryCacheService
  private dbService: DatabaseService
  private lastPrunedAt = 0

  constructor(dbService?: DatabaseService) {
    this.dbService = dbService || DatabaseService.getInstance()
  }

  public static getInstance(): QueryCacheService {
    if (!QueryCacheService.instance) {
      QueryCacheService.instance = new QueryCacheService()
    }
    return QueryCacheService.instance
  }

  /**
   * Checks whether a query result is already in the cache and returns it if valid.
   */
  async get(params: CacheQueryRequest): Promise<string[][] | null> {
    const cacheResult = await this.dbService.query<{
      response_data: string[][]
    }>(
      `WITH hit AS (
           SELECT id, response_data, last_accessed
           FROM census_data_cache
           WHERE request_hash = public.generate_cache_hash($1, $2, $3, $4, $5)
             AND expires_at > NOW()
         ), touch AS (
           UPDATE census_data_cache c
           SET last_accessed = NOW()
           FROM hit
           WHERE c.id = hit.id
             AND hit.last_accessed < NOW() - INTERVAL '${TOUCH_INTERVAL}'
         )
         SELECT response_data FROM hit`,
      [
        params.dataset,
        params.group,
        params.year,
        params.variables,
        params.geographySpec,
      ],
    )

    if (cacheResult.rows.length > 0) {
      return cacheResult.rows[0].response_data
    }
    return null
  }

  /**
   * Adds or updates a query result in the cache.
   */
  async set(
    params: CacheQueryRequest,
    data: string[][],
    duration: CacheDuration,
  ): Promise<void> {
    await this.dbService.query(
      `INSERT INTO census_data_cache (
           request_hash,
           dataset_code,
           year,
           variables,
           geography_spec,
           response_data,
           row_count,
           expires_at
         )
         VALUES (
           public.generate_cache_hash($1, $2, $3, $4, $5),
           $1,
           $3,
           $4,
           $5,
           $6,
           $7,
           NOW() + $8::interval
         )
         ON CONFLICT (request_hash) DO UPDATE SET
           response_data = EXCLUDED.response_data,
           row_count = EXCLUDED.row_count,
           expires_at = EXCLUDED.expires_at,
           last_accessed = NOW()`,
      [
        params.dataset,
        params.group,
        params.year,
        params.variables,
        params.geographySpec,
        JSON.stringify(data),
        data.length,
        duration.toString(),
      ],
    )

    await this.pruneIfDue()
  }

  /**
   * Prunes the cache if this container has not done so recently. Never
   * throws: housekeeping must not fail the query that happened to trigger it.
   */
  private async pruneIfDue(): Promise<void> {
    const now = Date.now()
    if (now - this.lastPrunedAt < PRUNE_INTERVAL_MS) return
    this.lastPrunedAt = now
    try {
      await this.prune()
    } catch (err) {
      console.error(`Cache prune failed: ${(err as Error).message}`)
    }
  }

  /**
   * Deletes expired rows, then the least recently used rows beyond
   * maxBytes of stored response data. Returns how many rows each step
   * removed.
   */
  async prune(
    maxBytes = CACHE_MAX_BYTES,
  ): Promise<{ expired: number; evicted: number }> {
    const expired = await this.dbService.query<{ id: string }>(
      `DELETE FROM census_data_cache
         WHERE expires_at < NOW()
         RETURNING id`,
    )

    // Walk the rows from most to least recently used, keeping a running
    // total of their stored size; everything past the budget goes.
    // pg_column_size reads the size from the row's TOAST pointer, so the
    // large response bodies are not loaded to measure them.
    const evicted = await this.dbService.query<{ id: string }>(
      `DELETE FROM census_data_cache
         WHERE id IN (
           SELECT id
           FROM (
             SELECT id,
                    SUM(pg_column_size(response_data)) OVER (
                      ORDER BY last_accessed DESC, id DESC
                    ) AS running_bytes
             FROM census_data_cache
           ) ranked
           WHERE running_bytes > $1
         )
         RETURNING id`,
      [maxBytes],
    )

    const result = {
      expired: expired.rows.length,
      evicted: evicted.rows.length,
    }
    if (result.expired > 0 || result.evicted > 0) {
      // console.error so it survives the DEBUG_LOGS suppression: an
      // eviction means the cache has reached its budget, worth seeing.
      console.error(
        `Cache pruned: ${result.expired} expired, ${result.evicted} evicted over the ${maxBytes}-byte budget`,
      )
    }
    return result
  }
}
