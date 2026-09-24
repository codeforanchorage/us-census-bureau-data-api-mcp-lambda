import { describe, expect, it, vi } from 'vitest'

// The real tools construct DatabaseService (a pg Pool) in their
// constructors; mock the driver so createServer() is side-effect free.
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({})),
  Client: vi.fn().mockImplementation(() => ({})),
}))

import { createServer } from '../src/createServer'

// End to end through the real registered schemas: the messages a model
// actually sees when it gets a call wrong.
describe('invalid tool arguments on real tools', () => {
  const server = createServer()

  it('lists every problem with fetch-aggregate-data, one line each', async () => {
    const result = await server.handleToolCall({
      params: {
        name: 'fetch-aggregate-data',
        arguments: { dataset: 'acs/acs5', year: '2023', get: {} },
      },
    })

    expect(result.isError).toBe(true)
    const text = result.content[0].text as string
    expect(text).toMatch(/^Invalid arguments for fetch-aggregate-data:\n/)
    expect(text).toContain('- year: Expected number, received string')
    // Readable lines, not ZodError.message's JSON dump.
    expect(text).not.toContain('"code"')
  })

  it('surfaces the custom geography rule as a correctable error', async () => {
    const result = await server.handleToolCall({
      params: {
        name: 'fetch-aggregate-data',
        arguments: {
          dataset: 'acs/acs5',
          year: 2023,
          get: { variables: ['B01001_001E'] },
        },
      },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain(
      'No geography specified error - define for or ucgid arguments.',
    )
  })

  it('reports a missing required field on list-table-variables', async () => {
    const result = await server.handleToolCall({
      params: {
        name: 'list-table-variables',
        arguments: { dataset: 'acs/acs5', year: 2023 },
      },
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('- table_id: Required')
  })

  it('still rejects an unknown tool as a protocol error', async () => {
    await expect(
      server.handleToolCall({ params: { name: 'no-such-tool' } }),
    ).rejects.toThrow(/Unknown tool: no-such-tool/)
  })
})
