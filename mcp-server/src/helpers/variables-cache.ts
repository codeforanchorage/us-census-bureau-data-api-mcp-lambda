// Cache for /data/<year>/<dataset>/variables.json.
//
// variables.json is the Rosetta Stone for Census responses: it gives the
// human label for every cell code, identifies which variables are estimates
// (_E) vs MOEs (_M), and lets us validate cell codes before forwarding to
// the API. Cached per (dataset, vintage) -- one fetch per session is enough.

import { fetchWithTimeout } from './http.js'

export interface VariableMeta {
  name: string
  label?: string
  concept?: string
  predicateType?: string
  group?: string
  attributes?: string
  // For estimate variables (suffix E), the paired MOE variable name (suffix M)
  // if present in this dataset's catalog.
  moePair?: string
}

export interface VariablesIndex {
  byName: Map<string, VariableMeta>
  // List of estimate variable names -- used for "did you mean" suggestions.
  estimateNames: string[]
  // Group codes (table IDs) present in this dataset's catalog -- used to
  // validate get.group requests before forwarding to the API.
  groupNames: Set<string>
}

interface RawVariableEntry {
  label?: string
  concept?: string
  predicateType?: string
  group?: string
  attributes?: string
}

interface RawVariablesResponse {
  variables: Record<string, RawVariableEntry>
}

const cache = new Map<string, Promise<VariablesIndex | null>>()

function cacheKey(dataset: string, year: number | string): string {
  return `${year}::${dataset}`
}

export function clearVariablesCache(): void {
  cache.clear()
}

export async function fetchVariablesIndex(
  dataset: string,
  year: number | string,
  apiKey?: string,
): Promise<VariablesIndex | null> {
  const key = cacheKey(dataset, year)
  const cached = cache.get(key)
  if (cached) return cached

  const promise = loadIndex(dataset, year, apiKey).catch((err) => {
    console.warn(`variables.json fetch failed for ${key}: ${String(err)}`)
    // Cache the null so we don't retry repeatedly within a session.
    return null
  })
  cache.set(key, promise)
  return promise
}

async function loadIndex(
  dataset: string,
  year: number | string,
  apiKey?: string,
): Promise<VariablesIndex | null> {
  const base = `https://api.census.gov/data/${year}/${dataset}/variables.json`
  const url = apiKey ? `${base}?key=${apiKey}` : base
  const res = await fetchWithTimeout(url)
  if (!res.ok) return null
  const data = (await res.json()) as RawVariablesResponse
  if (!data || typeof data !== 'object' || !data.variables) return null

  const byName = new Map<string, VariableMeta>()
  const groupNames = new Set<string>()
  for (const [name, entry] of Object.entries(data.variables)) {
    if (!entry || typeof entry !== 'object') continue
    byName.set(name, {
      name,
      label: entry.label,
      concept: entry.concept,
      predicateType: entry.predicateType,
      group: entry.group,
      attributes: entry.attributes,
    })
    // "N/A" is Census's placeholder for ungrouped variables like NAME.
    if (entry.group && entry.group !== 'N/A') groupNames.add(entry.group)
  }

  // Pair each estimate (suffix E) with its margin of error (suffix M).
  // ACS variables use the convention BXXXXX_NNNE / BXXXXX_NNNM consistently.
  const estimateNames: string[] = []
  for (const [name, meta] of byName) {
    if (name.endsWith('E')) {
      estimateNames.push(name)
      const moe = name.slice(0, -1) + 'M'
      if (byName.has(moe)) {
        meta.moePair = moe
      }
    }
  }

  return { byName, estimateNames, groupNames }
}

// Best-effort label lookup. Returns a string like "B25001_001E (Total housing
// units)" when known; otherwise the bare cell code. Strips the leading
// "Estimate!!" prefix Census attaches to ACS labels -- it's noise once the
// reader already knows they're looking at estimates.
export function labelForCell(
  index: VariablesIndex | null,
  cell: string,
): string {
  if (!index) return cell
  const meta = index.byName.get(cell)
  if (!meta?.label) return cell
  return `${cell} (${prettyLabel(meta.label)})`
}

export function prettyLabel(label: string): string {
  return label
    .replace(/^Estimate!!/, '')
    .replace(/!!/g, ' / ')
    .trim()
}

// Returns suggestions for a likely-typo cell code. Uses a simple
// Levenshtein-bounded prefix match -- good enough to catch B25001_999E ->
// B25001_001E without pulling in a library.
export function suggestCellCodes(
  index: VariablesIndex | null,
  cell: string,
  max = 3,
): string[] {
  if (!index) return []
  const upper = cell.toUpperCase()
  const candidates: { name: string; score: number }[] = []

  // Prefer same-table candidates: B25001_999E -> any B25001_*
  const tablePrefix = upper.split('_')[0]
  for (const name of index.byName.keys()) {
    if (!name.startsWith(tablePrefix)) continue
    const score = levenshtein(upper, name)
    candidates.push({ name, score })
  }

  // Fall back to global candidates if no same-table matches.
  if (candidates.length === 0) {
    for (const name of index.byName.keys()) {
      const score = levenshtein(upper, name)
      if (score <= 3) candidates.push({ name, score })
    }
  }

  candidates.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
  return candidates.slice(0, max).map((c) => c.name)
}

// Returns suggestions for a likely-typo group (table) code, e.g.
// B25001X -> B25001. Same Levenshtein approach as suggestCellCodes.
export function suggestGroupCodes(
  index: VariablesIndex | null,
  group: string,
  max = 3,
): string[] {
  if (!index) return []
  const upper = group.toUpperCase()
  const candidates: { name: string; score: number }[] = []
  for (const name of index.groupNames) {
    const score = levenshtein(upper, name.toUpperCase())
    if (score <= 3) candidates.push({ name, score })
  }
  candidates.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
  return candidates.slice(0, max).map((c) => c.name)
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}
