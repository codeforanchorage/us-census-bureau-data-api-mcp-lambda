// Response formatter for fetch-aggregate-data.
//
// Every Census data response goes through this formatter so the
// provenance banner, MOE pairing, sentinel decoding, reliability flags,
// and freshness caveats ride along with the data -- the model cannot
// ignore them because they sit in the same text block.
//
// Output is shaped for two consumers: Claude (handles markdown well) and
// GPT-4o via M365 Copilot (strips some inline formatting and de-prioritises
// content past the first ~200 tokens). To make caveats land on both:
//   - Caveats lead. The "## Caveats" section is the first thing the model
//     sees so it can't get summarised away.
//   - "## Section" headers, not just **bold**, so the structure survives
//     Copilot's renderer.
//   - Records are numbered blocks ("Record 1:") rather than tables.
//   - Critical caveats are repeated once at the bottom as a prose reminder
//     because 4o is more likely to drop a single-mention caveat.
//   - ASCII only -- "--" instead of em-dash, "+/-" instead of plus-or-minus
//     -- because Copilot rendering paths occasionally drop non-ASCII.

import { buildCitation } from './citation.js'
import {
  classifyDataset,
  isStaleVintage,
  vintageBannerParts,
} from './dataset-info.js'
import {
  getSentinelInfo,
  isSentinel,
  decodeSentinel,
} from './sentinels.js'
import {
  VariablesIndex,
  labelForCell,
} from './variables-cache.js'

export interface FormatInput {
  dataset: string
  year: number | string
  url: string
  headers: string[]
  rows: string[][]
  // Original `for=`/`in=`/`ucgid=`/`get=` echo for the Query section.
  queryEcho: string
  requestedVariables: string[]
  // MOE companion fields that we auto-added; surfaced as a caveat.
  autoAddedMoeFields: string[]
  variablesIndex: VariablesIndex | null
  currentYear: number
  // Threshold for CV-based LOW RELIABILITY flag. 0.30 is the standard
  // "use with caution" line.
  cvFlagThreshold?: number
}

// CV = (MOE / 1.645) / estimate. Above this is the "do not use precisely" zone.
const DEFAULT_CV_THRESHOLD = 0.3
// Treat data as a geography-row when one of these column headers appears.
const GEO_LEVEL_COLUMNS = new Set([
  'us',
  'state',
  'county',
  'tract',
  'block group',
  'block',
  'place',
  'zip code tabulation area',
  'congressional district',
  'school district (unified)',
  'school district (elementary)',
  'school district (secondary)',
  'county subdivision',
  'metropolitan statistical area/micropolitan statistical area',
  'public use microdata area',
  'urban area',
  'region',
  'division',
  'ucgid',
])

export function formatAggregateResponse(input: FormatInput): string {
  const {
    dataset,
    year,
    url,
    headers,
    rows,
    queryEcho,
    autoAddedMoeFields,
    variablesIndex,
    currentYear,
    cvFlagThreshold = DEFAULT_CV_THRESHOLD,
  } = input

  const decoded = decodeRows({
    headers,
    rows,
    variablesIndex,
    cvFlagThreshold,
  })

  const caveats: string[] = []
  const proseReminders: string[] = []

  // Reliability flags first (the most specific, highest-leverage caveat).
  for (const flag of decoded.reliabilityFlags) {
    caveats.push(flag)
  }
  if (decoded.reliabilityFlags.length > 0) {
    proseReminders.push(
      'one or more estimates above are flagged LOW RELIABILITY -- use the MOE band, not the point estimate',
    )
  }

  // Single-unit claim caveat.
  if (decoded.geographyRowCount === 1) {
    caveats.push(
      '**SINGLE-UNIT CLAIM:** this response covers exactly one geography. Do not generalize the estimate to a larger region.',
    )
    proseReminders.push(
      'this is a single-geography response -- do not generalize to a larger region',
    )
  }

  // Suppression sentinel caveat.
  if (decoded.sentinelHitCount > 0) {
    caveats.push(
      `**SUPPRESSED VALUES:** ${decoded.sentinelHitCount} cell(s) in this response were returned as Census suppression sentinels (translated inline as SUPPRESSED, NOT_APPLICABLE, INSUFFICIENT_SAMPLE, etc.). Do not treat these as numeric estimates.`,
    )
    proseReminders.push(
      `${decoded.sentinelHitCount} cell(s) above are suppression sentinels, not numeric estimates`,
    )
  }

  // Vintage staleness caveat.
  const staleness = stalenessBanner(dataset, year, currentYear)
  if (staleness) caveats.push(staleness)

  // MOE auto-pairing caveat.
  if (autoAddedMoeFields.length > 0) {
    caveats.push(
      `**MOE AUTO-PAIRED:** this response includes margin-of-error fields (${autoAddedMoeFields.join(', ')}) that you did not explicitly request. ACS estimates without their MOE are the single biggest source of confidently-wrong Census claims, so they are always returned alongside.`,
    )
  }

  const sections: string[] = []

  if (caveats.length > 0) {
    sections.push('## Caveats')
    sections.push(caveats.join('\n\n'))
  }

  sections.push('## Source')
  sections.push(buildProvenanceBanner(dataset, year))

  sections.push('## Query')
  sections.push(queryEcho)

  sections.push('## Records')
  sections.push(decoded.rendered || '(no records returned)')

  sections.push('## Provenance')
  const provenance: string[] = []
  provenance.push(buildCitation(url))
  provenance.push(`Retrieved: ${new Date().toISOString()}`)
  sections.push(provenance.join('\n'))

  if (proseReminders.length > 0) {
    sections.push(`(Reminder: ${proseReminders.join('; ')}.)`)
  }

  return sections.join('\n\n')
}

function buildProvenanceBanner(dataset: string, year: number | string): string {
  const banner = vintageBannerParts(dataset, year)
  const window = banner.collectionWindow
    ? ` (data collected ${banner.collectionWindow})`
    : ''
  return `${banner.label}, ${banner.yearLabel}${window}. Dataset: ${dataset}.`
}

function stalenessBanner(
  dataset: string,
  year: number | string,
  currentYear: number,
): string | null {
  if (!isStaleVintage(year, currentYear, 3)) return null
  const banner = vintageBannerParts(dataset, year)
  const window = banner.collectionWindow
    ? ` (collected ${banner.collectionWindow})`
    : ''
  return (
    `**DATA FRESHNESS:** this is ${banner.label} ${banner.yearLabel}${window}. ` +
    `A more recent release is likely available -- verify with list-datasets ` +
    `and use the latest vintage unless you specifically need the older window.`
  )
}

interface DecodeResult {
  rendered: string
  reliabilityFlags: string[]
  geographyRowCount: number
  sentinelHitCount: number
}

function decodeRows(opts: {
  headers: string[]
  rows: string[][]
  variablesIndex: VariablesIndex | null
  cvFlagThreshold: number
}): DecodeResult {
  const { headers, rows, variablesIndex, cvFlagThreshold } = opts

  // Build column index. Identify estimate (_E) columns paired with _M columns.
  const moeIndexByEstimate = new Map<number, number>()
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    if (h.endsWith('E')) {
      const expectedMoe = h.slice(0, -1) + 'M'
      const moeIdx = headers.indexOf(expectedMoe)
      if (moeIdx >= 0) moeIndexByEstimate.set(i, moeIdx)
    }
  }

  // Decode header line once.
  const headerLabels = headers.map((h) => {
    if (GEO_LEVEL_COLUMNS.has(h.toLowerCase()) || h === 'NAME') return h
    return labelForCell(variablesIndex, h)
  })

  const recordBlocks: string[] = []
  const reliabilityFlags: string[] = []
  let geographyRowCount = 0
  let sentinelHitCount = 0

  for (const row of rows) {
    geographyRowCount++
    const lines: string[] = [`Record ${geographyRowCount}:`]
    const usedColumns = new Set<number>()

    for (let i = 0; i < headers.length; i++) {
      if (usedColumns.has(i)) continue
      const col = headers[i]
      const raw = row[i]
      const label = headerLabels[i]

      if (moeIndexByEstimate.has(i)) {
        const moeIdx = moeIndexByEstimate.get(i)!
        usedColumns.add(moeIdx)
        const rendered = renderEstimateWithMoe({
          label,
          estimateRaw: raw,
          moeRaw: row[moeIdx],
          cvFlagThreshold,
          geographyName: extractName(headers, row),
          reliabilityFlags,
          estimateCode: col,
        })
        if (isSentinel(raw) || isSentinel(row[moeIdx])) sentinelHitCount++
        lines.push(`  ${rendered}`)
        continue
      }

      if (isSentinel(raw)) sentinelHitCount++
      lines.push(`  ${label}: ${decodeSentinel(raw)}`)
    }

    recordBlocks.push(lines.join('\n'))
  }

  return {
    rendered: recordBlocks.join('\n\n'),
    reliabilityFlags,
    geographyRowCount,
    sentinelHitCount,
  }
}

function renderEstimateWithMoe(opts: {
  label: string
  estimateRaw: string
  moeRaw: string
  cvFlagThreshold: number
  geographyName: string | null
  reliabilityFlags: string[]
  estimateCode: string
}): string {
  const { label, estimateRaw, moeRaw, cvFlagThreshold } = opts

  const estSentinel = getSentinelInfo(estimateRaw)
  const moeSentinel = getSentinelInfo(moeRaw)

  if (estSentinel) {
    return `${label}: ${estSentinel.short} (${estSentinel.description})`
  }

  const estimate = Number(estimateRaw)
  if (!Number.isFinite(estimate)) {
    return `${label}: ${estimateRaw}`
  }

  if (moeSentinel) {
    return (
      `${label}: ${formatNumber(estimate)} ` +
      `(MOE ${moeSentinel.short}: ${moeSentinel.description})`
    )
  }

  const moe = Number(moeRaw)
  if (!Number.isFinite(moe) || estimate === 0) {
    return `${label}: ${formatNumber(estimate)} +/- ${moeRaw}`
  }

  const cv = moe / 1.645 / Math.abs(estimate)
  const cvPct = Math.round(cv * 100)
  let suffix = ''
  if (cv > cvFlagThreshold) {
    suffix = ` **[LOW RELIABILITY: CV=${cvPct}%]**`
    const geo = opts.geographyName ? ` for ${opts.geographyName}` : ''
    opts.reliabilityFlags.push(
      `**LOW RELIABILITY:** ${opts.estimateCode}${geo} has CV=${cvPct}% ` +
        `(threshold ${Math.round(cvFlagThreshold * 100)}%). The estimate is ` +
        `too imprecise to support a precise claim -- use the MOE band, not ` +
        `the point estimate.`,
    )
  }

  return `${label}: ${formatNumber(estimate)} +/- ${formatNumber(moe)} (90% CI)${suffix}`
}

function extractName(headers: string[], row: string[]): string | null {
  const idx = headers.indexOf('NAME')
  if (idx < 0) return null
  return row[idx] ?? null
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

// Re-export for convenience in tests.
export const __testing = {
  buildProvenanceBanner,
  stalenessBanner,
  decodeRows,
  classifyDataset,
  isSentinel,
}
