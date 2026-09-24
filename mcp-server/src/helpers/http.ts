// Timeout wrapper around node-fetch for all api.census.gov calls.
//
// Without a timeout, a hung Census API connection burns the whole Lambda
// invocation until the API Gateway 29-second cutoff, and the client sees an
// opaque gateway timeout instead of an actionable error. Every outbound
// fetch in the tools should go through this wrapper.

import type { Response } from 'node-fetch'

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000

// node-fetch puts the full request URL in its error messages ("request to
// https://...&key=... failed, reason: ECONNRESET"), and the tools hand error
// messages straight back to the caller. Every Census URL carries the API
// key, so strip it before the error leaves this wrapper.
export function redactApiKey(text: string): string {
  return text.replace(/key=[^&\s]*/g, 'key=REDACTED')
}

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
    if (err instanceof Error) {
      err.message = redactApiKey(err.message)
      if (err.stack) err.stack = redactApiKey(err.stack)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
