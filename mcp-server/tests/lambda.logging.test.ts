import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'

const handleToolCall = vi.fn()

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

function toolCallEvent(): Parameters<typeof handler>[0] {
  return {
    httpMethod: 'POST',
    path: '/mcp',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'some-tool', arguments: {} },
    }),
  }
}

describe('caller errors vs server faults in the dispatch log', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/test'
    process.env.CENSUS_API_KEY = 'test-key'
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    handleToolCall.mockReset()
    delete process.env.DATABASE_URL
    delete process.env.CENSUS_API_KEY
  })

  it('logs a caller mistake (McpError) as a warning, never an error', async () => {
    handleToolCall.mockRejectedValue(
      new McpError(ErrorCode.MethodNotFound, 'Unknown tool: nope'),
    )
    const response = await handler(toolCallEvent())
    const body = JSON.parse(response.body)
    expect(body.error.code).toBe(ErrorCode.MethodNotFound)
    expect(warnSpy).toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logs a genuine fault with console.error and the original error', async () => {
    const boom = new Error('pool exhausted')
    handleToolCall.mockRejectedValue(boom)
    const response = await handler(toolCallEvent())
    const body = JSON.parse(response.body)
    expect(body.error.code).toBe(-32603)
    expect(errorSpy).toHaveBeenCalledWith(
      'Internal error on tools/call:',
      boom,
    )
  })
})
