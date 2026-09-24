import { describe, expect, it } from 'vitest'

import { createServer } from '../src/createServer'
import { SERVER_INSTRUCTIONS } from '../src/instructions'

describe('server instructions', () => {
  it('are ASCII only (Copilot GCC render paths drop non-ASCII)', () => {
    // eslint-disable-next-line no-control-regex
    expect(SERVER_INSTRUCTIONS).toMatch(/^[\x00-\x7F]*$/)
  })

  it('name only tools the server actually registers', () => {
    const registered = new Set(
      createServer()
        .getTools()
        .tools.map((t) => t.name),
    )
    const mentioned = SERVER_INSTRUCTIONS.match(
      /\b(?:resolve|search|fetch|list)-[a-z-]+[a-z]\b/g,
    )!
    expect(mentioned.length).toBeGreaterThan(0)
    for (const name of new Set(mentioned)) {
      expect(registered, `instructions mention ${name}`).toContain(name)
    }
  })
})
