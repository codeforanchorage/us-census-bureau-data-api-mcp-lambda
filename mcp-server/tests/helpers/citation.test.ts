import { describe, expect, it } from 'vitest'
import { buildCitation } from '../../src/helpers/citation'

describe('buildCitation', () => {
  it('should return a citation with the URL unchanged when no key parameter is present', () => {
    const url = 'https://api.census.gov/data/2020/acs/acs5'
    const citation = buildCitation(url)
    expect(citation).toBe(`Source: U.S. Census Bureau Data API (${url})`)
  })

  it('should redact the key query parameter', () => {
    const url = 'https://api.census.gov/data/2020/acs/acs5?key=test-api-key'
    const citation = buildCitation(url)
    expect(citation).toBe(
      `Source: U.S. Census Bureau Data API (https://api.census.gov/data/2020/acs/acs5?key=REDACTED)`,
    )
  })

  it('should redact the key even when it appears after other parameters', () => {
    const url =
      'https://api.census.gov/data/2020/acs/acs5?get=NAME&key=abc123&for=us:*'
    const citation = buildCitation(url)
    expect(citation).toBe(
      `Source: U.S. Census Bureau Data API (https://api.census.gov/data/2020/acs/acs5?get=NAME&key=REDACTED&for=us:*)`,
    )
  })

  it('should redact a URL-encoded key that no longer matches the raw env value', () => {
    const url = 'https://api.census.gov/data/2020/acs/acs5?key=abc%2Fdef'
    const citation = buildCitation(url)
    expect(citation).toBe(
      `Source: U.S. Census Bureau Data API (https://api.census.gov/data/2020/acs/acs5?key=REDACTED)`,
    )
  })
})
