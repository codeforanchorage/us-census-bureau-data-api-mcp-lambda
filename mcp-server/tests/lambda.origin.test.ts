import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handleToolCall = vi.fn().mockResolvedValue({ content: [] })

vi.mock('../src/createServer.js', () => ({
  createServer: vi.fn().mockImplementation(() => ({
    getTools: () => ({ tools: [] }),
    getPrompts: () => ({ prompts: [] }),
    handleToolCall,
    handleGetPrompt: vi.fn().mockResolvedValue({ messages: [] }),
  })),
}))

vi.mock('../src/services/database.service.js', () => ({
  DatabaseService: { getInstance: vi.fn().mockReturnValue({}) },
}))

import { handler } from '../src/lambda'

function pingEvent(
  headers: Record<string, string> = {},
  httpMethod = 'POST',
): Parameters<typeof handler>[0] {
  return {
    httpMethod,
    path: '/mcp',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:
      httpMethod === 'POST'
        ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
        : null,
  }
}

describe('browser Origin allowlist', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
    process.env.CENSUS_API_KEY = 'test-key'
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.DATABASE_URL
    delete process.env.CENSUS_API_KEY
  })

  it('serves requests with no Origin header (native clients, curl)', async () => {
    const response = await handler(pingEvent())
    expect(response.statusCode).toBe(200)
    // No origin to echo, so no ACAO header at all -- and never a wildcard.
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it.each([
    'https://claude.ai',
    'https://claude.com',
    'http://localhost:6274',
    'http://127.0.0.1:6274',
  ])('serves allowed origin %s and echoes it back', async (origin) => {
    const response = await handler(pingEvent({ Origin: origin }))
    expect(response.statusCode).toBe(200)
    expect(response.headers['Access-Control-Allow-Origin']).toBe(origin)
    expect(response.headers['Vary']).toBe('Origin')
  })

  it('refuses a disallowed origin with 403 and no CORS headers', async () => {
    const response = await handler(
      pingEvent({ Origin: 'https://evil.example' }),
    )
    expect(response.statusCode).toBe(403)
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined()
    const body = JSON.parse(response.body)
    expect(body.error.code).toBe(-32600)
    expect(body.error.message).toContain('https://evil.example')
  })

  it('refuses the OPTIONS preflight from a disallowed origin', async () => {
    const response = await handler(
      pingEvent({ Origin: 'https://evil.example' }, 'OPTIONS'),
    )
    expect(response.statusCode).toBe(403)
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('answers the OPTIONS preflight from an allowed origin with its echo', async () => {
    const response = await handler(
      pingEvent({ Origin: 'https://claude.ai' }, 'OPTIONS'),
    )
    expect(response.statusCode).toBe(204)
    expect(response.headers['Access-Control-Allow-Origin']).toBe(
      'https://claude.ai',
    )
  })

  it('matches the Origin header case-insensitively by header name', async () => {
    const response = await handler(
      pingEvent({ origin: 'https://evil.example' }),
    )
    expect(response.statusCode).toBe(403)
  })

  it('never emits a wildcard Access-Control-Allow-Origin', async () => {
    for (const event of [
      pingEvent(),
      pingEvent({ Origin: 'https://claude.ai' }),
      pingEvent({}, 'OPTIONS'),
    ]) {
      const response = await handler(event)
      expect(response.headers['Access-Control-Allow-Origin']).not.toBe('*')
    }
  })
})
