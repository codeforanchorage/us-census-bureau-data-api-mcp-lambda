import { describe, it, expect } from 'vitest'
import {
  classifyDataset,
  isStaleVintage,
  vintageBannerParts,
} from '../../src/helpers/dataset-info'

describe('classifyDataset', () => {
  it('identifies ACS 5-year with collection window', () => {
    const s = classifyDataset('acs/acs5')
    expect(s.kind).toBe('acs5')
    expect(s.collectionWindowYears).toBe(5)
  })

  it('identifies ACS 1-year as single-year', () => {
    const s = classifyDataset('acs/acs1')
    expect(s.kind).toBe('acs1')
    expect(s.collectionWindowYears).toBe(1)
  })

  it('identifies decennial census', () => {
    expect(classifyDataset('dec/sf1').kind).toBe('decennial')
  })

  it('falls back to a label echo for unknown datasets', () => {
    expect(classifyDataset('xyz/abc').label).toBe('xyz/abc')
  })
})

describe('vintageBannerParts', () => {
  it('spells out the ACS 5-year collection window', () => {
    const b = vintageBannerParts('acs/acs5', 2019)
    expect(b.label).toBe('ACS 5-Year Estimates')
    expect(b.yearLabel).toBe('2019')
    expect(b.collectionWindow).toBe('2015-2019')
  })

  it('omits the collection window for ACS 1-year', () => {
    const b = vintageBannerParts('acs/acs1', 2022)
    expect(b.collectionWindow).toBeUndefined()
  })
})

describe('isStaleVintage', () => {
  it('flags vintages more than 3 years older than the current year', () => {
    expect(isStaleVintage(2018, 2025)).toBe(true)
  })

  it('does not flag vintages within the threshold', () => {
    expect(isStaleVintage(2022, 2025)).toBe(false)
    expect(isStaleVintage(2025, 2025)).toBe(false)
  })

  it('handles non-numeric input gracefully', () => {
    expect(isStaleVintage('not-a-year', 2025)).toBe(false)
  })
})
