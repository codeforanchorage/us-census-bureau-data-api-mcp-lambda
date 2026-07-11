// Timeout wrapper around node-fetch for all api.census.gov calls.
//
// Without a timeout, a hung Census API connection burns the whole Lambda
// invocation until the API Gateway 29-second cutoff, and the client sees an
// opaque gateway timeout instead of an actionable error. Every outbound
// fetch in the tools should go through this wrapper.

import type { Response } from 'node-fetch'

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000

export async function fetchWithTimeout(
  url: string,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const fetch = (await import('node-fetch')).default
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Request to api.census.gov timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          `Retry after a short delay; if the failure persists the Census Data API may be slow or unavailable.`,
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
