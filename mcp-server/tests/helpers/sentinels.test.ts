import { describe, it, expect } from 'vitest'
import {
  decodeSentinel,
  getSentinelInfo,
  isSentinel,
} from '../../src/helpers/sentinels'

describe('sentinels', () => {
  it('decodes every documented sentinel value', () => {
    const cases: Array<[number, string]> = [
      [-999999999, 'SUPPRESSED'],
      [-888888888, 'NO_MOE_DISPLAYED'],
      [-666666666, 'NOT_APPLICABLE'],
      [-555555555, 'ESTIMATE_NOT_APPLICABLE'],
      [-333333333, 'INSUFFICIENT_SAMPLE'],
      [-222222222, 'OPEN_ENDED'],
      [-111111111, 'CONTROLLED_NO_MOE'],
    ]
    for (const [n, label] of cases) {
      expect(isSentinel(n)).toBe(true)
      expect(decodeSentinel(n)).toContain(label)
    }
  })

  it('accepts string representations (the Census API ships everything as strings)', () => {
    expect(isSentinel('-666666666')).toBe(true)
    expect(decodeSentinel('-666666666')).toContain('NOT_APPLICABLE')
  })

  it('returns the original value formatted as a string for real numbers', () => {
    expect(isSentinel(119420)).toBe(false)
    expect(decodeSentinel(119420)).toBe('119420')
    expect(decodeSentinel('119420')).toBe('119420')
  })

  it('rejects values outside the sentinel set', () => {
    expect(isSentinel(-123)).toBe(false)
    expect(isSentinel(-1)).toBe(false)
    expect(isSentinel(0)).toBe(false)
    expect(isSentinel('not a number')).toBe(false)
    expect(getSentinelInfo(null)).toBeNull()
    expect(getSentinelInfo(undefined)).toBeNull()
  })

  it('emits the human description so the meaning rides along with the value', () => {
    expect(decodeSentinel(-999999999)).toMatch(/suppressed/i)
    expect(decodeSentinel(-666666666)).toMatch(/not applicable/i)
    expect(decodeSentinel(-333333333)).toMatch(/sample size/i)
  })
})
