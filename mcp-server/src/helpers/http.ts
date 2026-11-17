// Timeout wrapper around node-fetch for all api.census.gov calls.
//
// Without a timeout, a hung Census API connection burns the whole Lambda
// invocation until the API Gateway 29-second cutoff, and the client sees an
// opaque gateway timeout instead of an actionable error. Every outbound
// fetch in the tools should go through this wrapper.
//
// Two clocks apply to each call:
//   - its own timeout (10s by default), which covers the response BODY as
//     well as the headers -- a server that sends headers and then stalls
//     would otherwise hang the read with no timer running;
//   - the tool call's overall deadline (withDeadline), because one tool call
//     can chain several fetches (get-indicator with product "auto" makes up
//     to six) and per-fetch timeouts alone add up past the Lambda limit.

import { AsyncLocalStorage } from 'node:async_hooks'

import type { Response } from 'node-fetch'

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000

// Wall-clock budget for everything one tool call fetches. Sits under the
// timeout ladder in prod.tfvars (API Gateway 29s, Lambda 28s) with room left
// to format the answer and write the cache row.
export const TOOL_CALL_BUDGET_MS = 24_000

// Below this much remaining budget a new request cannot realistically
// complete, so fail at once rather than start it.
const MIN_USEFUL_MS = 250

const deadlineStore = new AsyncLocalStorage<number>()

// Runs fn with an absolute deadline that every fetchWithTimeout call made
// inside it (however deeply) respects.
export function withDeadline<T>(
  budgetMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  return deadlineStore.run(Date.now() + budgetMs, fn)
}

// node-fetch puts the full request URL in its error messages ("request to
// https://...&key=... failed, reason: ECONNRESET"), and the tools hand error
// messages straight back to the caller. Every Census URL carries the API
// key, so strip it before the error leaves this wrapper.
export function redactApiKey(text: string): string {
  return text.replace(/key=[^&\s]*/g, 'key=REDACTED')
}

function timeoutError(ms: number): Error {
  return new Error(
    `Request to api.census.gov timed out after ${Math.max(1, Math.round(ms / 1000))}s. ` +
      `Retry after a short delay; if the failure persists the Census Data API may be slow or unavailable.`,
  )
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

type NodeStream = { on(event: string, listener: () => void): unknown }

export async function fetchWithTimeout(
  url: string,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  let effectiveMs = timeoutMs
  const deadline = deadlineStore.getStore()
  if (deadline !== undefined) {
    const remaining = deadline - Date.now()
    if (remaining < MIN_USEFUL_MS) {
      throw new Error(
        `The Census Data API responded too slowly to finish this request in time, so the ` +
          `remaining lookups were not attempted. Retry after a short delay; if the failure ` +
          `persists the Census Data API may be slow or unavailable.`,
      )
    }
    effectiveMs = Math.min(timeoutMs, remaining)
  }

  const fetch = (await import('node-fetch')).default
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), effectiveMs)
  // Never keep a stdio process alive just for this timer.
  timer.unref?.()

  let res: Response
  try {
    res = await fetch(url, { signal: controller.signal })
  } catch (err) {
    clearTimeout(timer)
    if (isAbort(err)) throw timeoutError(effectiveMs)
    if (err instanceof Error) {
      err.message = redactApiKey(err.message)
      if (err.stack) err.stack = redactApiKey(err.stack)
    }
    throw err
  }

  // Headers are in; keep the timer running until the body has been read.
  // node-fetch exposes the body as a Node stream. The listeners also absorb
  // the 'error' the abort emits on a body nobody went on to read.
  const body = res.body as unknown as NodeStream | null
  if (body && typeof body.on === 'function') {
    const done = () => clearTimeout(timer)
    body.on('end', done)
    body.on('close', done)
    body.on('error', done)
  } else {
    clearTimeout(timer)
  }

  // A body read cut off by the timer rejects with a bare AbortError; give
  // it the same actionable wording as a timeout before the headers.
  for (const method of ['text', 'json'] as const) {
    const read = res[method]?.bind(res) as (() => Promise<unknown>) | undefined
    if (!read) continue
    ;(res as unknown as Record<string, () => Promise<unknown>>)[method] = () =>
      read().catch((err: unknown) => {
        throw isAbort(err) ? timeoutError(effectiveMs) : err
      })
  }

  return res
}
