import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handleToolCall = vi.fn()
const handleGetPrompt = vi.fn()

vi.mock('../src/createServer.js', () => ({
  createServer: vi.fn().mockImplementation(() => ({
    getTools: () => ({ tools: [{ name: 'list-datasets' }] }),
    getPrompts: () => ({ prompts: [{ name: 'compare_places' }] }),
    handleToolCall,
    handleGetPrompt,
  })),
}))

vi.mock('../src/services/database.service.js', () => ({
  DatabaseService: { getInstance: vi.fn().mockReturnValue({}) },
}))

import { handler } from '../src/lambda'
import { SERVER_INSTRUCTIONS } from '../src/instructions'
import { SERVER_NAME, SERVER_VERSION } from '../src/version'
import { decodeHeaderValue } from '../src/modern-protocol'

const V = '2026-07-28'
const META = {
  'io.modelcontextprotocol/protocolVersion': V,
  'io.modelcontextprotocol/clientInfo': {
    name: 'modern-client',
    version: '2.0',
  },
  'io.modelcontextprotocol/clientCapabilities': {},
}

type Event = Parameters<typeof handler>[0]

// A well-formed 2026-07-28 request: _meta in the body, mirrored headers.
function modernEvent(
  method: string,
  params: Record<string, unknown> = {},
  headerOverrides: Record<string, string | undefined> = {},
  id: number | undefined = 1,
): Event {
  const name = typeof params.name === 'string' ? params.name : undefined
  const headers: Record<string, string | undefined> = {
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': V,
    'Mcp-Method': method,
    ...(name !== undefined ? { 'Mcp-Name': name } : {}),
    ...headerOverrides,
  }
  return {
    httpMethod: 'POST',
    path: '/mcp',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(id !== undefined ? { id } : {}),
      method,
      params: { ...params, _meta: META },
    }),
  }
}

const serverInfoMeta = {
  'io.modelcontextprotocol/serverInfo': {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
}

describe('MCP 2026-07-28 (modern) requests', () => {
  let stdout: string[]

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
    process.env.CENSUS_API_KEY = 'test-key'
    stdout = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    handleToolCall.mockReset().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    })
    handleGetPrompt.mockReset().mockResolvedValue({
      description: 'd',
      messages: [],
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.DATABASE_URL
    delete process.env.CENSUS_API_KEY
  })

  describe('server/discover', () => {
    it('advertises versions, capabilities, identity, instructions and cache hints', async () => {
      const response = await handler(modernEvent('server/discover'))
      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body).result).toEqual({
        resultType: 'complete',
        supportedVersions: [V],
        capabilities: { tools: {}, prompts: {} },
        instructions: SERVER_INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: 'public',
        _meta: serverInfoMeta,
      })
    })

    it('is not a legacy method', async () => {
      const response = await handler({
        httpMethod: 'POST',
        path: '/mcp',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
        }),
      })
      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body).error.code).toBe(-32601)
    })
  })

  describe('results', () => {
    it('marks list results complete and cacheable, with serverInfo', async () => {
      const tools = JSON.parse(
        (await handler(modernEvent('tools/list'))).body,
      ).result
      expect(tools).toEqual({
        tools: [{ name: 'list-datasets' }],
        resultType: 'complete',
        ttlMs: 3_600_000,
        cacheScope: 'public',
        _meta: serverInfoMeta,
      })
      const prompts = JSON.parse(
        (await handler(modernEvent('prompts/list'))).body,
      ).result
      expect(prompts.resultType).toBe('complete')
      expect(prompts.cacheScope).toBe('public')
    })

    it('marks tool results complete without cache hints and keeps their _meta', async () => {
      handleToolCall.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        _meta: { 'org.example/x': 1 },
      })
      const response = await handler(
        modernEvent('tools/call', { name: 'list-datasets', arguments: {} }),
      )
      const result = JSON.parse(response.body).result
      expect(result.resultType).toBe('complete')
      expect(result).not.toHaveProperty('ttlMs')
      expect(result._meta).toEqual({ 'org.example/x': 1, ...serverInfoMeta })
      expect(handleToolCall).toHaveBeenCalledWith({
        params: expect.objectContaining({
          name: 'list-datasets',
          arguments: {},
        }),
      })
    })

    it('serves prompts/get with a matching Mcp-Name', async () => {
      const response = await handler(
        modernEvent('prompts/get', { name: 'compare_places', arguments: {} }),
      )
      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body).result.resultType).toBe('complete')
    })

    it('never mints or echoes a session id', async () => {
      const response = await handler(
        modernEvent('tools/list', {}, { 'Mcp-Session-Id': 'stale-session' }),
      )
      expect(response.headers['mcp-session-id']).toBeUndefined()
    })

    it('logs clientInfo from _meta and the era, without arguments', async () => {
      await handler(
        modernEvent('tools/call', {
          name: 'list-datasets',
          arguments: { query: 'secret user text' },
        }),
      )
      const line = JSON.parse(stdout.find((l) => l.includes('jsonrpc_method'))!)
      expect(line).toEqual({
        mcp_era: 'modern',
        jsonrpc_method: 'tools/call',
        jsonrpc_params: {
          name: 'list-datasets',
          clientInfo: { name: 'modern-client', version: '2.0' },
        },
      })
      expect(JSON.stringify(line)).not.toContain('secret user text')
    })
  })

  describe('methods', () => {
    it.each(['initialize', 'ping', 'logging/setLevel', 'resources/list'])(
      'answers %s with HTTP 404 and -32601',
      async (method) => {
        const response = await handler(modernEvent(method))
        expect(response.statusCode).toBe(404)
        expect(JSON.parse(response.body).error.code).toBe(-32601)
      },
    )

    it('accepts a notification with 202 and no body', async () => {
      const response = await handler(
        modernEvent('notifications/cancelled', {}, {}, undefined),
      )
      expect(response.statusCode).toBe(202)
      expect(response.body).toBe('')
    })
  })

  describe('header validation (400 + HeaderMismatch -32020)', () => {
    const expectMismatch = async (event: Event, fragment: string) => {
      const response = await handler(event)
      expect(response.statusCode).toBe(400)
      const body = JSON.parse(response.body)
      expect(body.error.code).toBe(-32020)
      expect(body.error.message).toContain(fragment)
      expect(body.id).toBe(1)
    }

    it('requires MCP-Protocol-Version when _meta names a version', () =>
      expectMismatch(
        modernEvent('tools/list', {}, { 'MCP-Protocol-Version': undefined }),
        'MCP-Protocol-Version header is required',
      ))

    it('requires _meta when the header names a modern version', () =>
      expectMismatch(
        {
          httpMethod: 'POST',
          path: '/mcp',
          headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        },
        'is required with MCP-Protocol-Version',
      ))

    it('rejects a header/body version mismatch', () =>
      expectMismatch(
        modernEvent('tools/list', {}, { 'MCP-Protocol-Version': '2099-01-01' }),
        "does not match body value '2026-07-28'",
      ))

    it('requires Mcp-Method', () =>
      expectMismatch(
        modernEvent('tools/list', {}, { 'Mcp-Method': undefined }),
        'Mcp-Method header is required',
      ))

    it('rejects an Mcp-Method that differs from the body', () =>
      expectMismatch(
        modernEvent(
          'tools/call',
          { name: 'list-datasets' },
          {
            'Mcp-Method': 'tools/list',
          },
        ),
        "Mcp-Method header value 'tools/list'",
      ))

    it('requires Mcp-Name on tools/call', () =>
      expectMismatch(
        modernEvent(
          'tools/call',
          { name: 'list-datasets' },
          {
            'Mcp-Name': undefined,
          },
        ),
        'Mcp-Name header is required for tools/call',
      ))

    it('rejects an Mcp-Name that differs from the body', () =>
      expectMismatch(
        modernEvent(
          'tools/call',
          { name: 'list-datasets' },
          {
            'Mcp-Name': 'fetch-aggregate-data',
          },
        ),
        "Mcp-Name header value 'fetch-aggregate-data'",
      ))

    it('decodes a base64-sentinel Mcp-Name before comparing', async () => {
      const encoded = `=?base64?${Buffer.from('list-datasets').toString('base64')}?=`
      const response = await handler(
        modernEvent(
          'tools/call',
          { name: 'list-datasets' },
          {
            'Mcp-Name': encoded,
          },
        ),
      )
      expect(response.statusCode).toBe(200)
    })

    it('rejects a malformed base64 sentinel', () =>
      expectMismatch(
        modernEvent(
          'tools/call',
          { name: 'list-datasets' },
          {
            'Mcp-Name': '=?base64?not base64!?=',
          },
        ),
        'Mcp-Name header value is malformed',
      ))
  })

  describe('version negotiation', () => {
    it('answers an unsupported _meta version with 400 + -32022 listing what we serve', async () => {
      const event = modernEvent(
        'tools/list',
        {},
        {
          'MCP-Protocol-Version': '2099-01-01',
        },
      )
      const body = JSON.parse(event.body!)
      body.params._meta['io.modelcontextprotocol/protocolVersion'] =
        '2099-01-01'
      event.body = JSON.stringify(body)

      const response = await handler(event)
      expect(response.statusCode).toBe(400)
      expect(JSON.parse(response.body).error).toEqual({
        code: -32022,
        message: 'Unsupported protocol version',
        data: { supported: [V], requested: '2099-01-01' },
      })
    })

    it('leaves legacy initialize untouched: no resultType, session id minted', async () => {
      const response = await handler({
        httpMethod: 'POST',
        path: '/mcp',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'copilot', version: '1' },
          },
        }),
      })
      const result = JSON.parse(response.body).result
      expect(result.protocolVersion).toBe('2024-11-05')
      expect(result).not.toHaveProperty('resultType')
      expect(response.headers['mcp-session-id']).toMatch(/^[0-9a-f-]{36}$/)
    })
  })
})

describe('decodeHeaderValue', () => {
  it.each([
    ['plain', 'plain'],
    [
      `=?base64?${Buffer.from('Hello, 世界').toString('base64')}?=`,
      'Hello, 世界',
    ],
    ['bad\u0001char', undefined],
    ['=?base64?abc?=', undefined],
  ])('%s -> %s', (raw, expected) => {
    expect(decodeHeaderValue(raw)).toBe(expected)
  })
})
