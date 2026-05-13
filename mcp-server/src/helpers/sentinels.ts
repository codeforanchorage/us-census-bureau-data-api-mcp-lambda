// Census API special / suppression sentinel values.
//
// These appear in numeric cells where no real estimate is available. Without
// translation, downstream models will happily average or quote them as real
// numbers (-666666666 in a city population is the canonical disaster). Every
// data-rendering path should pass values through `decodeSentinel` so the
// special-value semantics ride along with the cell.

export interface SentinelInfo {
  sentinel: number
  short: string
  description: string
}

const SENTINELS: SentinelInfo[] = [
  {
    sentinel: -999999999,
    short: 'SUPPRESSED',
    description: 'estimate suppressed (jam value)',
  },
  {
    sentinel: -888888888,
    short: 'NO_MOE_DISPLAYED',
    description: 'margin of error not displayed (estimate is controlled)',
  },
  {
    sentinel: -666666666,
    short: 'NOT_APPLICABLE',
    description: 'ratio not displayed / not applicable',
  },
  {
    sentinel: -555555555,
    short: 'ESTIMATE_NOT_APPLICABLE',
    description: 'estimate not applicable',
  },
  {
    sentinel: -333333333,
    short: 'INSUFFICIENT_SAMPLE',
    description: 'sample size insufficient / suppressed',
  },
  {
    sentinel: -222222222,
    short: 'OPEN_ENDED',
    description: 'no sample observations / open-ended distribution',
  },
  {
    sentinel: -111111111,
    short: 'CONTROLLED_NO_MOE',
    description: 'controlled estimate / no margin of error available',
  },
]

const SENTINEL_INDEX = new Map<number, SentinelInfo>(
  SENTINELS.map((s) => [s.sentinel, s]),
)

export function isSentinel(value: unknown): boolean {
  const n = parseSentinelCandidate(value)
  return n !== null && SENTINEL_INDEX.has(n)
}

export function getSentinelInfo(value: unknown): SentinelInfo | null {
  const n = parseSentinelCandidate(value)
  if (n === null) return null
  return SENTINEL_INDEX.get(n) ?? null
}

// Returns a human-friendly string for sentinels, or the original value
// formatted as a string. Use when rendering a single estimate value in
// a response -- never let the raw sentinel reach the user.
export function decodeSentinel(value: unknown): string {
  const info = getSentinelInfo(value)
  if (info) {
    return `${info.short} (${info.description})`
  }
  if (value === null || value === undefined) return ''
  return String(value)
}

// Parses something that looks like it might be a sentinel. Census returns
// these as strings in JSON responses (the whole API is string-typed), so
// accept both. Reject non-integers and anything outside the sentinel range
// to avoid false positives.
function parseSentinelCandidate(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null
  }
  if (typeof value === 'string') {
    if (!/^-\d+$/.test(value.trim())) return null
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export const SENTINEL_VALUES: ReadonlyArray<SentinelInfo> = SENTINELS
