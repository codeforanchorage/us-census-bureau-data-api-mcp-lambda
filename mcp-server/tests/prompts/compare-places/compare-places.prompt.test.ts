import { describe, expect, it, vi } from 'vitest'

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({})),
  Client: vi.fn().mockImplementation(() => ({})),
}))

import { createServer } from '../../../src/createServer'
import { ComparePlacesPrompt } from '../../../src/prompts/compare-places.prompt'

describe('ComparePlacesPrompt', () => {
  it('builds a workflow prompt naming the places, topic, and MOE rule', async () => {
    const prompt = new ComparePlacesPrompt()
    const result = await prompt.handler({
      topic: 'median household income',
      places: 'Anchorage, Fairbanks',
    })

    expect(result.description).toBe(
      'Compare median household income across Anchorage, Fairbanks',
    )
    const text = result.messages[0].content.text
    expect(result.messages[0].role).toBe('user')
    expect(text).toContain('Anchorage, Fairbanks')
    for (const tool of [
      'resolve-geography-fips',
      'search-data-tables',
      'list-table-variables',
      'fetch-aggregate-data',
    ]) {
      expect(text).toContain(tool)
    }
    expect(text).toContain('margin of error')
    // ASCII only (Copilot GCC render paths drop non-ASCII).
    expect(text).toMatch(/^[\x20-\x7E\n]*$/)
  })

  it('requires both arguments', () => {
    const prompt = new ComparePlacesPrompt()
    expect(prompt.argsSchema.safeParse({ topic: 'income' }).success).toBe(false)
    expect(
      prompt.arguments.filter((a) => a.required).map((a) => a.name),
    ).toEqual(['topic', 'places'])
  })
})

describe('prompts/list', () => {
  it('lists every prompt with a title', () => {
    const { prompts } = createServer().getPrompts()
    expect(prompts.map((p) => [p.name, p.title])).toEqual([
      ['get_population_data', 'Population of a Place'],
      ['compare_places', 'Compare Places'],
    ])
  })
})
