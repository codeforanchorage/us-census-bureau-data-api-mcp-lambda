import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/createServer.js', () => ({
  createServer: vi.fn().mockImplementation(() => ({
    getTools: () => ({ tools: [] }),
    getPrompts: () => ({ prompts: [] }),
    handleToolCall: vi.fn().mockResolvedValue({ content: [] }),
    handleGetPrompt: vi.fn().mockResolvedValue({ messages: [] }),
  })),
}))

vi.mock('../src/services/database.service.js', () => ({
  DatabaseService: { getInstance: vi.fn().mockReturnValue({}) },
}))

import { handler } from '../src/lambda'
import { SERVER_INSTRUCTIONS } from '../src/instructions'
import { SERVER_NAME, SERVER_VERSION } from '../src/version'

function postEvent(
  body: unknown,
  headers: Record<string, string> = {},
): Parameters<typeof handler>[0] {
  return {
    httpMethod: 'POST',
    path: '/mcp',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }
}

function initializeEvent(protocolVersion?: string) {
  return postEvent({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    },
  })
}

describe('protocol version negotiation', () => {
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

  it.each(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'])(
    'echoes supported revision %s back to the client',
    async (version) => {
      const response = await handler(initializeEvent(version))
      expect(response.statusCode).toBe(200)
      const body = JSON.parse(response.body)
      expect(body.result.protocolVersion).toBe(version)
    },
  )

  it('answers an unsupported requested revision with the latest we support', async () => {
    const response = await handler(initializeEvent('2026-07-28'))
    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  it('answers a missing protocolVersion param with the latest we support', async () => {
    const response = await handler(initializeEvent(undefined))
    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  it('reports the shared server identity in serverInfo', async () => {
    const response = await handler(initializeEvent('2025-11-25'))
    const body = JSON.parse(response.body)
    expect(body.result.serverInfo).toEqual({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    })
  })

  it('returns server instructions on every negotiated revision', async () => {
    for (const version of ['2025-11-25', '2024-11-05']) {
      const response = await handler(initializeEvent(version))
      const body = JSON.parse(response.body)
      expect(body.result.instructions).toBe(SERVER_INSTRUCTIONS)
    }
  })
})

describe('MCP-Protocol-Version header validation', () => {
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

  const ping = { jsonrpc: '2.0', id: 7, method: 'ping' }

  it('passes requests with no header through untouched (older clients)', async () => {
    const response = await handler(postEvent(ping))
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body).result).toEqual({})
  })

  it.each(['2025-11-25', '2025-03-26', '2024-11-05'])(
    'accepts supported header %s',
    async (version) => {
      const response = await handler(
        postEvent(ping, { 'MCP-Protocol-Version': version }),
      )
      expect(response.statusCode).toBe(200)
    },
  )

  it('rejects an unrecognized header with HTTP 400 and JSON-RPC -32600', async () => {
    const response = await handler(
      postEvent(ping, { 'MCP-Protocol-Version': '2026-07-28' }),
    )
    expect(response.statusCode).toBe(400)
    const body = JSON.parse(response.body)
    expect(body.error.code).toBe(-32600)
    expect(body.error.message).toContain('2026-07-28')
    // The rejection carries the request id so the client can correlate it.
    expect(body.id).toBe(7)
  })

  it('matches the header case-insensitively', async () => {
    const response = await handler(
      postEvent(ping, { 'mcp-protocol-version': 'not-a-version' }),
    )
    expect(response.statusCode).toBe(400)
  })
})
