import { describe, it, expect, vi, afterEach } from 'vitest'

const mockFetch = vi.fn()
vi.mock('node-fetch', () => ({ default: mockFetch }))

import { PassThrough } from 'node:stream'

import { fetchWithTimeout, withDeadline } from '../../src/helpers/http'

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

  it('redacts the API key from network error messages', async () => {
    // node-fetch's real FetchError format embeds the full request URL.
    mockFetch.mockRejectedValueOnce(
      new Error(
        'request to https://api.census.gov/data/2023/acs/acs5?get=NAME&key=SECRET123&for=state:02 failed, reason: ECONNRESET',
      ),
    )
    const err = await fetchWithTimeout(
      'https://api.census.gov/data/2023/acs/acs5?get=NAME&key=SECRET123&for=state:02',
    ).catch((e: Error) => e)
    expect(err.message).not.toContain('SECRET123')
    expect(err.stack).not.toContain('SECRET123')
    expect(err.message).toContain('key=REDACTED&for=state:02')
    expect(err.message).toContain('ECONNRESET')
  })

  it('rethrows non-abort errors unchanged', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'))
    await expect(
      fetchWithTimeout('https://api.census.gov/data.json'),
    ).rejects.toThrow('Network error')
  })

  it('keeps timing a body that stalls after the headers arrive', async () => {
    // node-fetch hands back a Node stream body; headers come at once, the
    // body never does, and the abort surfaces as an AbortError on the read.
    mockFetch.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) => {
        const body = new PassThrough()
        const aborted = new Promise<never>((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.')
            err.name = 'AbortError'
            body.destroy(err)
            reject(err)
          })
        })
        return Promise.resolve({
          ok: true,
          status: 200,
          body,
          text: () => aborted,
          json: () => aborted,
        })
      },
    )

    const res = await fetchWithTimeout('https://api.census.gov/stall', 300)
    await expect(res.text()).rejects.toThrow(/timed out after 1s/)
  })

  it('does not abort an unread body once it has ended', async () => {
    const body = new PassThrough()
    let signal: AbortSignal | undefined
    mockFetch.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) => {
        signal = opts.signal
        return Promise.resolve({ ok: true, status: 200, body })
      },
    )
    await fetchWithTimeout('https://api.census.gov/done', 100)
    body.end()
    body.resume()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(signal?.aborted).toBe(false)
  })
})

describe('withDeadline', () => {
  const hang = (_url: string, opts: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.')
        err.name = 'AbortError'
        reject(err)
      })
    })

  it('caps a fetch at the time left in the budget', async () => {
    mockFetch.mockImplementation(hang)
    const started = Date.now()
    await expect(
      withDeadline(400, () =>
        fetchWithTimeout('https://api.census.gov/slow', 10_000),
      ),
    ).rejects.toThrow(/timed out/)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('refuses to start a fetch once the budget is spent', async () => {
    mockFetch.mockImplementation(hang)
    const err = await withDeadline(300, async () => {
      await fetchWithTimeout('https://api.census.gov/first').catch(() => {})
      return fetchWithTimeout('https://api.census.gov/second')
    }).catch((e: Error) => e)

    expect((err as Error).message).toMatch(/too slowly to finish/)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('leaves fetches outside a deadline on their own timeout', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await fetchWithTimeout('https://api.census.gov/data.json')
    expect(await res.text()).toBe('ok')
  })
})
