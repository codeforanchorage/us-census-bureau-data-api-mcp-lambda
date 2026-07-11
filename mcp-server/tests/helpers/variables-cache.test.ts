import { describe, it, expect, vi, afterEach } from 'vitest'

const mockFetch = vi.fn()
vi.mock('node-fetch', () => ({ default: mockFetch }))

import {
  clearVariablesCache,
  fetchVariablesIndex,
  labelForCell,
  prettyLabel,
  suggestCellCodes,
  suggestGroupCodes,
} from '../../src/helpers/variables-cache'

const variablesJson = {
  variables: {
    B25001_001E: {
      label: 'Estimate!!Total housing units',
      concept: 'Housing Units',
      predicateType: 'int',
      group: 'B25001',
    },
    B25001_001M: {
      label: 'Margin of Error!!Total housing units',
      group: 'B25001',
    },
    B25003_001E: {
      label: 'Estimate!!Total!!Occupied housing units',
      group: 'B25003',
    },
    NAME: { label: 'Geographic Area Name', group: 'N/A' },
  },
}

function mockResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

afterEach(() => {
  clearVariablesCache()
  mockFetch.mockReset()
})

describe('fetchVariablesIndex', () => {
  it('builds an index keyed by variable name', async () => {
    mockFetch.mockReturnValueOnce(mockResponse(variablesJson))
    const idx = await fetchVariablesIndex('acs/acs5', 2019, 'KEY')
    expect(idx).not.toBeNull()
    expect(idx!.byName.get('B25001_001E')?.label).toContain(
      'Total housing units',
    )
  })

  it('pairs every _E estimate with its _M margin of error when present', async () => {
    mockFetch.mockReturnValueOnce(mockResponse(variablesJson))
    const idx = await fetchVariablesIndex('acs/acs5', 2019, 'KEY')
    expect(idx!.byName.get('B25001_001E')?.moePair).toBe('B25001_001M')
    // B25003_001E has no _M companion in the fixture, so no pair.
    expect(idx!.byName.get('B25003_001E')?.moePair).toBeUndefined()
  })

  it('caches per (dataset, year) — only one fetch per key', async () => {
    mockFetch.mockReturnValue(mockResponse(variablesJson))
    await fetchVariablesIndex('acs/acs5', 2019, 'KEY')
    await fetchVariablesIndex('acs/acs5', 2019, 'KEY')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('returns null and degrades silently on fetch failure', async () => {
    mockFetch.mockReturnValueOnce(
      Promise.resolve(new Response('nope', { status: 404 })),
    )
    const idx = await fetchVariablesIndex('xyz/abc', 9999)
    expect(idx).toBeNull()
  })
})

describe('labelForCell + prettyLabel', () => {
  it('renders a cell code with its human label', async () => {
    mockFetch.mockReturnValueOnce(mockResponse(variablesJson))
    const idx = await fetchVariablesIndex('acs/acs5', 2019, 'KEY')
    expect(labelForCell(idx, 'B25001_001E')).toBe(
      'B25001_001E (Total housing units)',
    )
  })

  it('returns the bare code when the index is unavailable', () => {
    expect(labelForCell(null, 'B25001_001E')).toBe('B25001_001E')
  })

  it('strips the leading "Estimate!!" prefix and rewrites separators', () => {
    expect(prettyLabel('Estimate!!Total!!Occupied housing units')).toBe(
      'Total / Occupied housing units',
    )
  })
})

describe('attribute-only variables (live-catalog shape)', () => {
  // Mirrors the real acs/acs5 2023 catalog: NAME and the _M/_EA/_MA
  // companions are NOT top-level entries; they only appear in `attributes`.
  const attributeOnlyJson = {
    variables: {
      GEO_ID: { label: 'Geography', group: 'N/A', attributes: 'NAME' },
      B01003_001E: {
        label: 'Estimate!!Total',
        group: 'B01003',
        attributes: 'B01003_001EA,B01003_001M,B01003_001MA',
      },
    },
  }

  it('indexes attribute names so validation accepts NAME and annotations', async () => {
    mockFetch.mockReturnValueOnce(mockResponse(attributeOnlyJson))
    const idx = await fetchVariablesIndex('acs/acs5', 2023, 'KEY')
    expect(idx!.byName.has('NAME')).toBe(true)
    expect(idx!.byName.has('B01003_001EA')).toBe(true)
    expect(idx!.byName.has('B01003_001MA')).toBe(true)
  })

  it('pairs the MOE companion even when it only exists as an attribute', async () => {
    mockFetch.mockReturnValueOnce(mockResponse(attributeOnlyJson))
    const idx = await fetchVariablesIndex('acs/acs5', 2023, 'KEY')
    expect(idx!.byName.get('B01003_001E')?.moePair).toBe('B01003_001M')
  })
})

describe('groupNames + suggestGroupCodes', () => {
  it('collects group codes and excludes the "N/A" placeholder', async () => {
    mockFetch.mockReturnValueOnce(mockResponse(variablesJson))
    const idx = await fetchVariablesIndex('acs/acs5', 2019, 'KEY')
    expect(idx!.groupNames.has('B25001')).toBe(true)
    expect(idx!.groupNames.has('B25003')).toBe(true)
    expect(idx!.groupNames.has('N/A')).toBe(false)
  })

  it('suggests near-miss group codes for typos', async () => {
    mockFetch.mockReturnValueOnce(mockResponse(variablesJson))
    const idx = await fetchVariablesIndex('acs/acs5', 2019, 'KEY')
    expect(suggestGroupCodes(idx, 'B25002')).toContain('B25001')
  })

  it('returns empty when no index is available', () => {
    expect(suggestGroupCodes(null, 'B25001')).toEqual([])
  })
})

describe('suggestCellCodes', () => {
  it('suggests same-table neighbours for typos', async () => {
    mockFetch.mockReturnValueOnce(mockResponse(variablesJson))
    const idx = await fetchVariablesIndex('acs/acs5', 2019, 'KEY')
    const suggestions = suggestCellCodes(idx, 'B25001_999E')
    expect(suggestions).toContain('B25001_001E')
  })

  it('returns empty when no index is available', () => {
    expect(suggestCellCodes(null, 'B25001_999E')).toEqual([])
  })
})
