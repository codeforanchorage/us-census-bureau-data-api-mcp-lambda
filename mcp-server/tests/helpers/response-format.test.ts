import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/helpers/citation', () => ({
  buildCitation: vi.fn(
    (url: string) => `Source: U.S. Census Bureau Data API (${url})`,
  ),
}))

import { formatAggregateResponse } from '../../src/helpers/response-format'
import type { VariablesIndex } from '../../src/helpers/variables-cache'

// Walk a string by code point rather than a regex so eslint's no-control-regex
// rule does not fire on the literal ASCII range.
function findNonAscii(s: string): string[] {
  const out: string[] = []
  for (const ch of s) {
    if (ch.charCodeAt(0) > 127) out.push(ch)
  }
  return out
}

function makeIndex(): VariablesIndex {
  const byName = new Map<string, { name: string; label?: string; moePair?: string }>([
    [
      'B25001_001E',
      {
        name: 'B25001_001E',
        label: 'Estimate!!Total housing units',
        moePair: 'B25001_001M',
      },
    ],
    [
      'B25001_001M',
      { name: 'B25001_001M', label: 'Margin of Error!!Total housing units' },
    ],
    ['NAME', { name: 'NAME', label: 'Geographic Area Name' }],
  ])
  return { byName, estimateNames: ['B25001_001E'] }
}

function baseInput(overrides: Partial<Parameters<typeof formatAggregateResponse>[0]> = {}) {
  return {
    dataset: 'acs/acs5',
    year: 2022,
    url: 'https://example',
    headers: ['NAME', 'B25001_001E', 'B25001_001M', 'state'],
    rows: [['Alaska', '300000', '1500', '02']],
    queryEcho: 'get=NAME,B25001_001E,B25001_001M, dataset=acs/acs5, year=2022',
    requestedVariables: ['B25001_001E'],
    autoAddedMoeFields: ['B25001_001M'],
    variablesIndex: makeIndex(),
    currentYear: 2025,
    ...overrides,
  }
}

describe('formatAggregateResponse (Copilot/4o shape)', () => {
  describe('ASCII-only output', () => {
    it('emits no non-ASCII bytes', () => {
      const out = formatAggregateResponse(baseInput())
      const offending = findNonAscii(out)
      expect(offending).toEqual([])
    })

    it('uses +/- rather than the plus-minus glyph', () => {
      const out = formatAggregateResponse(baseInput())
      expect(out).toContain('+/-')
    })
  })

  describe('section headers', () => {
    it('uses ## Source, ## Query, ## Records, ## Provenance sections', () => {
      const out = formatAggregateResponse(baseInput())
      expect(out).toMatch(/^## Caveats[\s\S]*## Source[\s\S]*## Query[\s\S]*## Records[\s\S]*## Provenance/m)
    })

    it('keeps Source after Caveats so the caveats lead', () => {
      const out = formatAggregateResponse(baseInput())
      const caveatsIdx = out.indexOf('## Caveats')
      const sourceIdx = out.indexOf('## Source')
      expect(caveatsIdx).toBeGreaterThanOrEqual(0)
      expect(caveatsIdx).toBeLessThan(sourceIdx)
    })

    it('omits the ## Caveats section entirely when there are no caveats', () => {
      const out = formatAggregateResponse(
        baseInput({
          autoAddedMoeFields: [],
          rows: [
            ['Alaska', '300000', '1500', '02'],
            ['Alabama', '2200000', '5000', '01'],
          ],
        }),
      )
      expect(out).not.toContain('## Caveats')
      expect(out.indexOf('## Source')).toBeGreaterThanOrEqual(0)
    })
  })

  describe('numbered record blocks', () => {
    it('renders rows as "Record N:" blocks rather than pipe-joined inline', () => {
      const out = formatAggregateResponse(
        baseInput({
          rows: [
            ['Alaska', '300000', '1500', '02'],
            ['Alabama', '2200000', '5000', '01'],
          ],
        }),
      )
      expect(out).toContain('Record 1:')
      expect(out).toContain('Record 2:')
    })

    it('shows the human cell label inside the record block', () => {
      const out = formatAggregateResponse(baseInput())
      expect(out).toContain('B25001_001E (Total housing units)')
      expect(out).toContain('300,000')
      expect(out).toContain('1,500')
      expect(out).toContain('(90% CI)')
    })

    it('renders (no records returned) when the API returned an empty result set', () => {
      const out = formatAggregateResponse(baseInput({ rows: [] }))
      expect(out).toContain('(no records returned)')
    })
  })

  describe('lead-with-caveats (single mention, no trailing duplication)', () => {
    it('leads with SINGLE-UNIT CLAIM before the records', () => {
      const out = formatAggregateResponse(baseInput())
      expect(out).toContain('**SINGLE-UNIT CLAIM:**')
      // Caveat sits before records.
      expect(out.indexOf('**SINGLE-UNIT CLAIM:**')).toBeLessThan(
        out.indexOf('Record 1:'),
      )
      // GPT-5.1 holds a lead caveat: no trailing prose-reminder duplication.
      expect(out).not.toMatch(/\(Reminder:/)
    })

    it('LOW RELIABILITY caveat fires once in the ## Caveats section', () => {
      const out = formatAggregateResponse(
        baseInput({
          rows: [['Test Tract', '1000', '600', '02']],
        }),
      )
      expect(out).toContain('LOW RELIABILITY')
      expect(out).not.toMatch(/\(Reminder:/)
    })

    it('emits the SUPPRESSED VALUES caveat when a sentinel is hit', () => {
      const out = formatAggregateResponse(
        baseInput({
          rows: [['Suppressed Place', '-666666666', '-666666666', '02']],
        }),
      )
      expect(out).toContain('**SUPPRESSED VALUES:**')
      expect(out).toContain('NOT_APPLICABLE')
      // No trailing prose-reminder duplication.
      expect(out).not.toMatch(/\(Reminder:/)
      // Sentinel itself never leaks through.
      expect(out).not.toMatch(/-666666666/)
    })

    it('does NOT flag LOW RELIABILITY on a precise estimate (no false-alarm training)', () => {
      const out = formatAggregateResponse(
        baseInput({
          rows: [['Test Tract', '100000', '1500', '02']],
        }),
      )
      expect(out).not.toContain('LOW RELIABILITY')
    })
  })

  describe('provenance + freshness', () => {
    it('Source section spells out the ACS 5-year collection window', () => {
      const out = formatAggregateResponse(
        baseInput({ year: 2019 }),
      )
      expect(out).toContain('ACS 5-Year Estimates, 2019')
      expect(out).toContain('data collected 2015-2019')
    })

    it('echoes the query verbatim in the ## Query section', () => {
      const out = formatAggregateResponse(baseInput())
      expect(out).toContain(
        'get=NAME,B25001_001E,B25001_001M, dataset=acs/acs5, year=2022',
      )
    })

    it('announces auto-paired MOE in the caveats section', () => {
      const out = formatAggregateResponse(baseInput())
      expect(out).toContain('**MOE AUTO-PAIRED:**')
      expect(out).toContain('B25001_001M')
    })

    it('emits DATA FRESHNESS for stale vintages', () => {
      const out = formatAggregateResponse(
        baseInput({ year: 2018, currentYear: 2025 }),
      )
      expect(out).toContain('DATA FRESHNESS')
    })

    it('does NOT emit DATA FRESHNESS for recent vintages', () => {
      const out = formatAggregateResponse(
        baseInput({ year: 2023, currentYear: 2025 }),
      )
      expect(out).not.toContain('DATA FRESHNESS')
    })

    it('appends a UTC retrieval timestamp under ## Provenance', () => {
      const out = formatAggregateResponse(baseInput())
      expect(out).toMatch(/Retrieved: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })
})
