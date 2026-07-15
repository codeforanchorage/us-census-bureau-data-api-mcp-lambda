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
  const byName = new Map<
    string,
    { name: string; label?: string; moePair?: string }
  >([
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
  return {
    byName,
    estimateNames: ['B25001_001E'],
    groupNames: new Set(['B25001']),
  }
}

function baseInput(
  overrides: Partial<Parameters<typeof formatAggregateResponse>[0]> = {},
) {
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
      expect(out).toMatch(
        /^## Caveats[\s\S]*## Source[\s\S]*## Query[\s\S]*## Records[\s\S]*## Provenance/m,
      )
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

  describe('record cap', () => {
    function manyRows(n: number): string[][] {
      return Array.from({ length: n }, (_, i) => [
        `Place ${i + 1}`,
        '300000',
        '1500',
        '02',
      ])
    }

    it('caps rendered records at 100 by default with a leading TRUNCATED caveat', () => {
      const out = formatAggregateResponse(baseInput({ rows: manyRows(250) }))
      expect(out).toContain('**TRUNCATED:**')
      expect(out).toContain('returned 250 records')
      // 100 visible rows is over the compact threshold, so the records render
      // as the compact table, capped at 100 data lines.
      expect(out).toContain('100 records in compact table format')
      expect(out).toContain('Place 100 |')
      expect(out).not.toContain('Place 101 |')
      // Truncation caveat leads the caveats section, before any records.
      expect(out.indexOf('**TRUNCATED:**')).toBeLessThan(
        out.indexOf('Place 1 |'),
      )
      // Trailing truncation notice (a notice, not caveat duplication).
      expect(out).toContain(
        '(Reminder: only the first 100 of 250 records are shown above.)',
      )
    })

    it('honors a custom maxRecords', () => {
      const out = formatAggregateResponse(
        baseInput({ rows: manyRows(5), maxRecords: 3 }),
      )
      expect(out).toContain('Record 3:')
      expect(out).not.toContain('Record 4:')
      expect(out).toContain('**TRUNCATED:**')
    })

    it('does not emit TRUNCATED when the row count is under the cap', () => {
      const out = formatAggregateResponse(baseInput({ rows: manyRows(100) }))
      expect(out).not.toContain('**TRUNCATED:**')
      expect(out).toContain('100 records in compact table format')
      expect(out).toContain('Place 100 |')
      expect(out).not.toMatch(/\(Reminder:/)
    })
  })

  describe('compact table format for large results', () => {
    function manyRows(n: number, est = '300000', moe = '1500'): string[][] {
      return Array.from({ length: n }, (_, i) => [
        `Place ${i + 1}`,
        est,
        moe,
        '02',
      ])
    }

    it('switches to the compact table above 20 records', () => {
      const out = formatAggregateResponse(baseInput({ rows: manyRows(21) }))
      expect(out).toContain('21 records in compact table format')
      expect(out).toContain('NAME | B25001_001E (+/- MOE) | state')
      expect(out).toContain('Place 1 | 300,000 +/- 1,500 | 02')
      expect(out).not.toContain('Record 1:')
      // Labels move to a one-time legend instead of repeating per record.
      expect(out).toContain('B25001_001E = Total housing units')
    })

    it('keeps Record blocks at exactly 20 records', () => {
      const out = formatAggregateResponse(baseInput({ rows: manyRows(20) }))
      expect(out).toContain('Record 20:')
      expect(out).not.toContain('compact table format')
    })

    it('keeps the surrounding sections intact in compact mode', () => {
      const out = formatAggregateResponse(baseInput({ rows: manyRows(30) }))
      expect(out).toMatch(
        /## Source[\s\S]*## Query[\s\S]*## Records[\s\S]*## Provenance/m,
      )
    })

    it('emits only ASCII in compact mode', () => {
      const out = formatAggregateResponse(baseInput({ rows: manyRows(30) }))
      expect(findNonAscii(out)).toEqual([])
    })

    it('decodes sentinels to their short code in compact cells', () => {
      const rows = manyRows(21)
      rows[5] = ['Suppressed Place', '-666666666', '-666666666', '02']
      const out = formatAggregateResponse(baseInput({ rows }))
      expect(out).toContain('Suppressed Place | NOT_APPLICABLE | 02')
      expect(out).not.toMatch(/-666666666/)
      expect(out).toContain('**SUPPRESSED VALUES:**')
    })

    it('aggregates LOW RELIABILITY into a single caveat with inline flags', () => {
      // est 1000, moe 600 -> CV = 600/1.645/1000 = 36%
      const out = formatAggregateResponse(
        baseInput({ rows: manyRows(25, '1000', '600') }),
      )
      expect(out).toContain('[LOW CV=36%]')
      expect(out).toContain('25 estimate value(s)')
      // One aggregated caveat, not one per row.
      expect(out.match(/\*\*LOW RELIABILITY:\*\*/g)).toHaveLength(1)
    })
  })

  describe('provenance + freshness', () => {
    it('Source section spells out the ACS 5-year collection window', () => {
      const out = formatAggregateResponse(baseInput({ year: 2019 }))
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
