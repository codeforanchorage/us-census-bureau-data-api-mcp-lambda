// ACS product selection (1-year vs 5-year) for fetch-aggregate-data.
//
// The Census Bureau publishes ACS 1-year estimates only for areas of 65,000+
// people and never below county-subdivision level; 5-year estimates cover
// every area but describe a five-year period. Callers that do not know which
// applies pass product: "auto" and the tool decides, saying which and why.
//
// Observed API behaviour this is built on (verified 2026-11-08):
//   - one small area on acs1        -> HTTP 204, empty body
//   - a wildcard on acs1            -> 200 with the 65k+ areas ONLY; the
//                                      small ones are silently absent
//   - tract / block group on acs1   -> 400 "unknown/unsupported geography"
//   - an unpublished vintage        -> 404 (2020 acs1; acs5 before release)
// The silent wildcard drop is why several geographies always get 5-year.

export type AcsProduct = 'auto' | '1-year' | '5-year'
export const ACS_PRODUCTS: readonly AcsProduct[] = ['auto', '1-year', '5-year']

// Families published in both products under the same table ids.
const ACS_PAIRED = /^acs\/acs([15])(\/subject|\/profile|\/cprofile)?$/

export type AcsFamily = { product: '1-year' | '5-year'; suffix: string }

export function acsFamily(dataset: string): AcsFamily | null {
  const m = ACS_PAIRED.exec(dataset.trim().toLowerCase())
  if (!m) return null
  return { product: m[1] === '1' ? '1-year' : '5-year', suffix: m[2] ?? '' }
}

export function acsDataset(product: '1-year' | '5-year', suffix: string) {
  return `acs/acs${product === '1-year' ? '1' : '5'}${suffix}`
}

// Levels ACS 1-year never publishes, whatever their population.
const NO_ACS1_LEVELS = new Set([
  'tract',
  'block group',
  'block',
  'zip code tabulation area',
])

export function forLevel(forParam?: string): string | null {
  if (!forParam) return null
  const idx = forParam.indexOf(':')
  return idx < 0 ? null : forParam.slice(0, idx).trim().toLowerCase()
}

export function acs1Unpublished(forParam?: string): boolean {
  const level = forLevel(forParam)
  return level !== null && NO_ACS1_LEVELS.has(level)
}

// Exactly one geography: no wildcard and no comma list in for=, in= or
// ucgid=. A parent wildcard (in=state:*) also fans out to many areas.
export function isSingleGeography(geo: {
  for?: string
  in?: string
  ucgid?: string
}): boolean {
  const many = (spec?: string) =>
    spec !== undefined && (spec.includes('*') || spec.includes(','))
  return !many(geo.for) && !many(geo.in) && !many(geo.ucgid)
}

// The period a 5-year vintage covers, e.g. 2024 -> "2020-2024".
export function fiveYearPeriod(year: number): string {
  return `${year - 4}-${year}`
}
