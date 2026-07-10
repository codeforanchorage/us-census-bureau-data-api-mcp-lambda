import { describe, it, expect, vi, afterEach } from 'vitest'

const mockFetch = vi.fn()
vi.mock('node-fetch', () => ({ default: mockFetch }))

import { fetchWithTimeout } from '../../src/helpers/http'

afterEach(() => {
  mockFetch.mockReset()
})

describe('fetchWithTimeout', () => {
  it('passes the response through and sends an abort signal', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await fetchWithTimeout('https://api.census.gov/data.json')
    expect(res.status).toBe(200)
    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('https://api.census.gov/data.json')
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('translates an abort into an actionable timeout error', async () => {
    // Real (short) timer: the fetch mock hangs until the wrapper aborts it.
    mockFetch.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )

    await expect(
      fetchWithTimeout('https://api.census.gov/slow', 1000),
    ).rejects.toThrow(/timed out after 1s/)
  })

  it('rethrows non-abort errors unchanged', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'))
    await expect(
      fetchWithTimeout('https://api.census.gov/data.json'),
    ).rejects.toThrow('Network error')
  })
})
