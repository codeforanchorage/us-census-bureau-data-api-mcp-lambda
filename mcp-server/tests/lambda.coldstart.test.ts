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

// Own file on purpose: the memoized server promise is module state, and this
// test needs a module that has never completed a cold start.
import { handler } from '../src/lambda'

function toolsListEvent(): Parameters<typeof handler>[0] {
  return {
    httpMethod: 'POST',
    path: '/mcp',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }
}

describe('cold-start failure recovery', () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.DB_SECRET_ARN
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.DATABASE_URL
    delete process.env.CENSUS_API_KEY
  })

  it('retries initialization after a failed cold start instead of caching the failure', async () => {
    // No DATABASE_URL and no DB_SECRET_ARN: loadSecrets throws.
    const failed = await handler(toolsListEvent())
    expect(failed.statusCode).toBe(500)
    expect(JSON.parse(failed.body).error.message).toMatch(
      /Initialization failed/,
    )

    // The transient cause clears; the same warm container must recover.
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
    process.env.CENSUS_API_KEY = 'test-key'
    const recovered = await handler(toolsListEvent())
    expect(recovered.statusCode).toBe(200)
    expect(JSON.parse(recovered.body).result).toEqual({ tools: [] })
  })
})
