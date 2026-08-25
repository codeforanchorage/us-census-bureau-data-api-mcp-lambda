import { describe, expect, it, vi } from 'vitest'

// The real tools construct DatabaseService (a pg Pool) in their
// constructors; mock the driver so createServer() is side-effect free.
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({})),
  Client: vi.fn().mockImplementation(() => ({})),
}))

import { createServer } from '../src/createServer'

// Display names for every registered tool. This list is the test's
// authority: a NEW tool without a title fails the coverage check below,
// and a STALE entry for a removed tool fails the reverse check -- both
// directions must break loudly or the metadata rots the next time the
// tool set changes.
const EXPECTED_TITLES: Record<string, string> = {
  'fetch-aggregate-data': 'Fetch Aggregate Data',
  'fetch-dataset-geography': 'Fetch Dataset Geography',
  'list-datasets': 'List Datasets',
  'resolve-geography-fips': 'Resolve Geography FIPS',
  'search-data-tables': 'Search Data Tables',
}

describe('tools/list metadata', () => {
  const { tools } = createServer().getTools()

  it('registers exactly the expected tools (stale title entries fail here)', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      Object.keys(EXPECTED_TITLES).sort(),
    )
  })

  it('carries the expected top-level title on every tool', () => {
    for (const tool of tools) {
      expect(tool.title, `tool ${tool.name} is missing its title`).toBe(
        EXPECTED_TITLES[tool.name],
      )
    }
  })

  it('marks every tool read-only against the open Census world', () => {
    for (const tool of tools) {
      expect(tool.annotations, `tool ${tool.name} has no annotations`).toEqual({
        readOnlyHint: true,
        openWorldHint: true,
      })
    }
  })

  it('never emits idempotentHint (meaningful only when readOnlyHint is false)', () => {
    for (const tool of tools) {
      expect(tool.annotations).not.toHaveProperty('idempotentHint')
    }
  })
})
