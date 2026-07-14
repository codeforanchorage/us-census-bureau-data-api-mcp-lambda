import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest'

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

function usageLines(writeSpy: MockInstance): Record<string, unknown>[] {
  return writeSpy.mock.calls
    .map(([chunk]) => {
      try {
        return JSON.parse(String(chunk)) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter(
      (parsed): parsed is Record<string, unknown> =>
        parsed !== null && 'jsonrpc_method' in parsed,
    )
}

describe('lambda handler usage logging', () => {
  let writeSpy: MockInstance

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
    process.env.CENSUS_API_KEY = 'test-key'
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.DATABASE_URL
    delete process.env.CENSUS_API_KEY
  })

  it('assigns a session id on initialize and logs client info', async () => {
    const response = await handler(
      postEvent({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'claude-ai', version: '1.0' },
        },
      }),
    )

    expect(response.statusCode).toBe(200)
    const sessionId = response.headers['mcp-session-id']
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)

    const [line] = usageLines(writeSpy)
    expect(line).toMatchObject({
      mcp_session_id: sessionId,
      jsonrpc_method: 'initialize',
      jsonrpc_params: { clientInfo: { name: 'claude-ai', version: '1.0' } },
    })
  })

  it('echoes the client session id and logs the tool name without arguments', async () => {
    const response = await handler(
      postEvent(
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'list-datasets',
            arguments: { secret: 'should-not-be-logged' },
          },
        },
        { 'Mcp-Session-Id': 'abc-123' },
      ),
    )

    expect(response.statusCode).toBe(200)
    expect(response.headers['mcp-session-id']).toBe('abc-123')

    const [line] = usageLines(writeSpy)
    expect(line).toMatchObject({
      mcp_session_id: 'abc-123',
      jsonrpc_method: 'tools/call',
      jsonrpc_params: { name: 'list-datasets' },
    })
    expect(JSON.stringify(line)).not.toContain('should-not-be-logged')
  })

  it('logs pings without inventing a session id', async () => {
    const response = await handler(
      postEvent({ jsonrpc: '2.0', id: 3, method: 'ping' }),
    )

    expect(response.statusCode).toBe(200)
    expect(response.headers['mcp-session-id']).toBeUndefined()

    const [line] = usageLines(writeSpy)
    expect(line.jsonrpc_method).toBe('ping')
    expect(line).not.toHaveProperty('mcp_session_id')
  })

  it('does not emit a usage line for unparseable or method-less requests', async () => {
    await handler({
      httpMethod: 'POST',
      path: '/mcp',
      headers: {},
      body: 'not json',
    })
    await handler(postEvent({ jsonrpc: '2.0', id: 4 }))

    expect(usageLines(writeSpy)).toHaveLength(0)
  })
})

describe('DEBUG_LOGS suppression in the lambda entrypoint', () => {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  }

  afterEach(() => {
    console.log = original.log
    console.info = original.info
    console.warn = original.warn
    delete process.env.DEBUG_LOGS
    delete process.env.DATABASE_URL
    delete process.env.CENSUS_API_KEY
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('silences console.log/info/warn when DEBUG_LOGS is false, but usage lines still flow', async () => {
    process.env.DEBUG_LOGS = 'false'
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
    process.env.CENSUS_API_KEY = 'test-key'

    vi.resetModules()
    const { handler: freshHandler } = await import('../src/lambda')

    expect(console.log).not.toBe(original.log)
    expect(console.info).not.toBe(original.info)
    expect(console.warn).not.toBe(original.warn)

    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)

    await freshHandler(
      postEvent({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    )

    expect(usageLines(writeSpy)).toHaveLength(1)
  })
})
