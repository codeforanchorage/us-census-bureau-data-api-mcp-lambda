import { afterEach, beforeEach, describe, expect, it, vi, Mock } from 'vitest'
import { Pool } from 'pg'

vi.mock('pg', () => ({
  Pool: vi.fn(),
  Client: vi.fn(),
}))

import { DatabaseService } from '../../src/services/database.service'

describe('database error hygiene', () => {
  let mockClient: { query: Mock; release: Mock }
  let mockPool: { connect: Mock; end: Mock }
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // DatabaseService is a singleton; reach in and reset it so each test
    // constructs against this test's pool mock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(DatabaseService as any).instance = undefined
    mockClient = { query: vi.fn(), release: vi.fn() }
    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      end: vi.fn(),
    }
    // A `function`, not an arrow: Vitest 4 mocks must be constructible
    // because DatabaseService calls `new Pool(...)`.
    vi.mocked(Pool).mockImplementation(function () {
      return mockPool as unknown as InstanceType<typeof Pool>
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(DatabaseService as any).instance = undefined
  })

  it('never lets a raw driver error reach the caller', async () => {
    const pgError = Object.assign(
      new Error('password authentication failed for user "mcp_user"'),
      { code: '28P01' },
    )
    mockClient.query.mockRejectedValue(pgError)

    const service = DatabaseService.getInstance()
    await expect(service.query('SELECT 1')).rejects.toThrow(
      'temporarily unavailable',
    )
    // The sanitized message must not carry the driver's details...
    await service.query('SELECT 1').catch((err: Error) => {
      expect(err.message).not.toContain('password')
      expect(err.message).not.toContain('mcp_user')
    })
    // ...but the operator gets the real error in the log.
    expect(errorSpy).toHaveBeenCalledWith('Database query failed:', pgError)
  })

  it('maps a statement_timeout cancellation to an actionable timeout message', async () => {
    const pgError = Object.assign(
      new Error('canceling statement due to statement timeout'),
      { code: '57014' },
    )
    mockClient.query.mockRejectedValue(pgError)

    const service = DatabaseService.getInstance()
    await expect(service.query('SELECT pg_sleep(60)')).rejects.toThrow(
      'timed out',
    )
  })

  it('sanitizes connection-acquisition failures too', async () => {
    mockPool.connect.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432'),
    )

    const service = DatabaseService.getInstance()
    await service.query('SELECT 1').catch((err: Error) => {
      expect(err.message).not.toContain('10.0.0.5')
      expect(err.message).toContain('temporarily unavailable')
    })
    expect(errorSpy).toHaveBeenCalled()
  })

  it('still releases the client after a query failure', async () => {
    mockClient.query.mockRejectedValue(new Error('boom'))
    const service = DatabaseService.getInstance()
    await service.query('SELECT 1').catch(() => {})
    expect(mockClient.release).toHaveBeenCalled()
  })
})
