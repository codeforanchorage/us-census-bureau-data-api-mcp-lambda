import { describe, it, expect, beforeEach, vi, Mock } from 'vitest'
import { DatabaseService } from '../../src/services/database.service.js'
import {
  QueryCacheService,
  CacheDuration,
  CacheDurationUnit,
  CacheQueryRequest,
  PRUNE_INTERVAL_MS,
} from '../../src/services/queryCache.service.js'

vi.mock('../../src/services/database.service.js', () => ({
  DatabaseService: {
    getInstance: vi.fn(),
  },
}))

describe('QueryCacheService', () => {
  let cacheService: QueryCacheService
  let mockDbService: {
    query: Mock
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDbService = {
      query: vi.fn(),
    }
    ;(DatabaseService.getInstance as Mock).mockReturnValue(mockDbService)

    cacheService = new QueryCacheService()
  })

  describe('CacheDuration', () => {
    it('renders as a Postgres interval string', () => {
      expect(new CacheDuration(1, CacheDurationUnit.YEAR).toString()).toBe(
        '1 year',
      )
      expect(new CacheDuration(6, CacheDurationUnit.HOUR).toString()).toBe(
        '6 hour',
      )
    })

    it('rejects non-integer and non-positive durations', () => {
      expect(() => new CacheDuration(1.5, CacheDurationUnit.DAY)).toThrow(
        'integer',
      )
      expect(() => new CacheDuration(0, CacheDurationUnit.DAY)).toThrow(
        'greater than zero',
      )
    })
  })

  describe('get', () => {
    const params: CacheQueryRequest = {
      dataset: 'acs/acs1',
      group: 'B01001',
      year: 2022,
      variables: ['B01001_001E'],
      geographySpec: JSON.stringify({ for: 'state:01', in: null }),
    }

    it('returns data when found in cache and not expired', async () => {
      const cachedData = [
        ['NAME', 'COUNT'],
        ['Alabama', '5000000'],
      ]
      mockDbService.query.mockResolvedValueOnce({
        rows: [{ response_data: cachedData }],
      })

      const result = await cacheService.get(params)

      expect(result).toEqual(cachedData)
      expect(mockDbService.query).toHaveBeenCalledWith(
        expect.stringMatching(
          /FROM census_data_cache[\s\S]+SELECT response_data FROM hit/,
        ),
        [
          params.dataset,
          params.group,
          params.year,
          params.variables,
          params.geographySpec,
        ],
      )
    })

    it('returns null when not found in cache', async () => {
      mockDbService.query.mockResolvedValueOnce({ rows: [] })

      const result = await cacheService.get(params)

      expect(result).toBeNull()
    })
  })

  describe('set', () => {
    const params: CacheQueryRequest = {
      dataset: 'acs/acs1',
      group: 'B01001',
      year: 2022,
      variables: ['B01001_001E'],
      geographySpec: JSON.stringify({ for: 'state:01', in: null }),
    }
    const data = [
      ['NAME', 'COUNT'],
      ['Alabama', '5000000'],
    ]
    const duration = new CacheDuration(1, CacheDurationUnit.YEAR)

    it('successfully inserts data into cache', async () => {
      mockDbService.query.mockResolvedValue({ rows: [] })

      await cacheService.set(params, data, duration)

      expect(mockDbService.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO census_data_cache'),
        [
          params.dataset,
          params.group,
          params.year,
          params.variables,
          params.geographySpec,
          JSON.stringify(data),
          data.length,
          '1 year',
        ],
      )
    })
  })

  describe('get touches last_accessed', () => {
    it('refreshes a stale last_accessed in the same statement as the read', async () => {
      mockDbService.query.mockResolvedValueOnce({ rows: [] })
      await cacheService.get({
        dataset: 'acs/acs1',
        group: null,
        year: 2022,
        variables: [],
        geographySpec: '{}',
      })
      expect(mockDbService.query).toHaveBeenCalledTimes(1)
      const sql = mockDbService.query.mock.calls[0][0] as string
      expect(sql).toMatch(
        /UPDATE census_data_cache c\s+SET last_accessed = NOW\(\)/,
      )
      expect(sql).toMatch(/hit\.last_accessed < NOW\(\) - INTERVAL '1 day'/)
    })
  })

  describe('pruning', () => {
    const params: CacheQueryRequest = {
      dataset: 'acs/acs1',
      group: null,
      year: 2022,
      variables: ['B01001_001E'],
      geographySpec: '{}',
    }
    const duration = new CacheDuration(1, CacheDurationUnit.YEAR)
    const statements = () =>
      mockDbService.query.mock.calls.map(([sql]) =>
        String(sql).trim().split(/\s+/).slice(0, 2).join(' '),
      )

    it('deletes expired rows, then the least recently used beyond the budget', async () => {
      mockDbService.query
        .mockResolvedValueOnce({ rows: [{ id: '1' }, { id: '2' }] })
        .mockResolvedValueOnce({ rows: [{ id: '3' }] })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await cacheService.prune(1000)

      expect(result).toEqual({ expired: 2, evicted: 1 })
      const [expiredSql] = mockDbService.query.mock.calls[0]
      expect(expiredSql).toMatch(
        /DELETE FROM census_data_cache\s+WHERE expires_at < NOW\(\)/,
      )
      const [evictSql, evictParams] = mockDbService.query.mock.calls[1]
      expect(evictSql).toMatch(/ORDER BY last_accessed DESC, id DESC/)
      expect(evictSql).toMatch(/running_bytes > \$1/)
      expect(evictParams).toEqual([1000])
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('2 expired, 1 evicted'),
      )
      errorSpy.mockRestore()
    })

    it('stays quiet when there is nothing to prune', async () => {
      mockDbService.query.mockResolvedValue({ rows: [] })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await cacheService.prune()).toEqual({ expired: 0, evicted: 0 })
      expect(errorSpy).not.toHaveBeenCalled()
      errorSpy.mockRestore()
    })

    it('prunes after a write, but only once per interval', async () => {
      mockDbService.query.mockResolvedValue({ rows: [] })
      const deletes = () =>
        statements().filter((s) => s === 'DELETE FROM').length

      await cacheService.set(params, [['A']], duration)
      expect(statements()).toEqual([
        'INSERT INTO',
        'DELETE FROM',
        'DELETE FROM',
      ])

      await cacheService.set(params, [['A']], duration)
      expect(deletes()).toBe(2)

      const nowSpy = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Date.now() + PRUNE_INTERVAL_MS + 1)
      await cacheService.set(params, [['A']], duration)
      nowSpy.mockRestore()
      expect(deletes()).toBe(4)
    })

    it('never fails the write when pruning fails', async () => {
      mockDbService.query
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('prune boom'))
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(
        cacheService.set(params, [['A']], duration),
      ).resolves.toBeUndefined()
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache prune failed: prune boom'),
      )
      errorSpy.mockRestore()
    })
  })

  describe('getInstance', () => {
    it('returns a singleton instance', () => {
      const instance1 = QueryCacheService.getInstance()
      const instance2 = QueryCacheService.getInstance()
      expect(instance1).toBe(instance2)
      expect(instance1).toBeInstanceOf(QueryCacheService)
    })
  })
})
