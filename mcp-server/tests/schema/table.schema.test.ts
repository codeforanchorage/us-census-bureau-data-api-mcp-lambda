import { describe, expect, it } from 'vitest'
import { predicatesSchema } from '../../src/schema/table.schema'

describe('predicatesSchema', () => {
  it('accepts ordinary predicate keys', () => {
    const result = predicatesSchema.safeParse({
      NAICS2017: '23',
      time: '2021',
      EMPSZES_1: '001',
    })
    expect(result.success).toBe(true)
  })

  it.each(['get', 'for', 'in', 'ucgid', 'key', 'descriptive', 'KEY', 'For'])(
    'rejects the reserved query parameter "%s"',
    (reserved) => {
      const result = predicatesSchema.safeParse({ [reserved]: 'anything' })
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('reserved')
      }
    },
  )

  it('rejects keys with characters that could restructure the query string', () => {
    for (const key of ['a&b', 'a=b', 'a b', 'a?b', 'a#b']) {
      const result = predicatesSchema.safeParse({ [key]: 'v' })
      expect(result.success).toBe(false)
    }
  })
})
