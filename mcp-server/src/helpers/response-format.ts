// Response formatter for fetch-aggregate-data.
//
// Every Census data response goes through this formatter so the
// provenance banner, MOE pairing, sentinel decoding, reliability flags,
// and freshness caveats ride along with the data -- the model cannot
// ignore them because they sit in the same text block.
//
// Output is shaped for two consumers: Claude and GPT-5.1 via M365 Copilot
// (GCC). The structural choices below are about Copilot's *renderer*, not
// model capability, so they stay regardless of which model is behind it:
//   - Caveats lead. The "## Caveats" section is the first thing the model
//     sees so it can't get summarised away.
//   - "## Section" headers, not just **bold**, so the structure survives
//     Copilot's renderer.
//   - Small results render as numbered blocks ("Record 1:") rather than
//     markdown tables. Above COMPACT_FORMAT_THRESHOLD records the blocks
//     cost several times more tokens than the data they carry, so large
//     results switch to a compact delimited table inside a code fence
//     (a fence survives both renderers; a markdown table does not).
//   - ASCII only -- "--" instead of em-dash, "+/-" instead of plus-or-minus
//     -- because Copilot rendering paths occasionally drop non-ASCII.
// We previously repeated each critical caveat as a trailing prose reminder
// because GPT-4o dropped single-mention caveats. GPT-5.1 holds a lead caveat
// reliably, so that duplication is gone -- the flags below carry the weight
// once, up top.

import { buildCitation } from './citation.js'
import {
  classifyDataset,
  isStaleVintage,
  vintageBannerParts,
} from './dataset-info.js'
import { getSentinelInfo, isSentinel, decodeSentinel } from './sentinels.js'
import { VariablesIndex, labelForCell, prettyLabel } from './variables-cache.js'

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
  // Cap on rendered Record blocks. Wildcard geography queries (e.g. every
  // tract in a state) can return thousands of rows, which would blow out the
  // consuming model's context.
  maxRecords?: number
  // Above this many rendered records, switch from "Record N:" blocks to the
  // compact delimited-table format.
  compactThreshold?: number
}

// CV = (MOE / 1.645) / estimate. Above this is the "do not use precisely" zone.
const DEFAULT_CV_THRESHOLD = 0.3
const DEFAULT_MAX_RECORDS = 100
const COMPACT_FORMAT_THRESHOLD = 20
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
    maxRecords = DEFAULT_MAX_RECORDS,
    compactThreshold = COMPACT_FORMAT_THRESHOLD,
  } = input

  const totalRecords = rows.length
  const truncated = totalRecords > maxRecords
  const visibleRows = truncated ? rows.slice(0, maxRecords) : rows

  const decoded = decodeRows({
    headers,
    rows: visibleRows,
    variablesIndex,
    cvFlagThreshold,
    compact: visibleRows.length > compactThreshold,
  })

  const caveats: string[] = []

  // Truncation first -- every downstream claim depends on knowing the
  // response is partial. Reliability flags below cover shown records only.
  if (truncated) {
    caveats.push(
      `**TRUNCATED:** the query returned ${totalRecords} records; showing the first ${maxRecords}. ` +
        `Do not compute totals or rankings from this partial list. Narrow the geography ` +
        `(for/in/ucgid) and re-run to get a complete result.`,
    )
  }

  // Reliability flags next (the most specific, highest-leverage caveat).
  for (const flag of decoded.reliabilityFlags) {
    caveats.push(flag)
  }

  // Single-unit claim caveat.
  if (decoded.geographyRowCount === 1) {
    caveats.push(
      '**SINGLE-UNIT CLAIM:** this response covers exactly one geography. Do not generalize the estimate to a larger region.',
    )
  }

  // Suppression sentinel caveat.
  if (decoded.sentinelHitCount > 0) {
    caveats.push(
      `**SUPPRESSED VALUES:** ${decoded.sentinelHitCount} cell(s) were Census suppression sentinels, decoded inline (e.g. SUPPRESSED, NOT_APPLICABLE). Do not treat them as numbers.`,
    )
  }

  // Vintage staleness caveat.
  const staleness = stalenessBanner(dataset, year, currentYear)
  if (staleness) caveats.push(staleness)

  // MOE auto-pairing caveat.
  if (autoAddedMoeFields.length > 0) {
    caveats.push(
      `**MOE AUTO-PAIRED:** margin-of-error fields (${autoAddedMoeFields.join(', ')}) were added automatically. Report each estimate with its MOE, not on its own.`,
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

  // Truncation notice, not caveat duplication: mirrors the trailing
  // "(Reminder: ...)" lines in resolve-geography-fips and search-data-tables.
  if (truncated) {
    sections.push(
      `(Reminder: only the first ${maxRecords} of ${totalRecords} records are shown above.)`,
    )
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
    `A newer release is likely available -- check list-datasets unless you need this vintage.`
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
  compact?: boolean
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

  if (opts.compact) {
    return renderCompactTable({
      headers,
      rows,
      variablesIndex,
      cvFlagThreshold,
      moeIndexByEstimate,
    })
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

// Compact rendering for large results: one delimited line per record inside
// a code fence, MOE merged into its estimate's cell, labels factored out
// into a one-time column legend. Reliability flags are aggregated into a
// single caveat here -- per-cell caveat lines would defeat the purpose.
function renderCompactTable(opts: {
  headers: string[]
  rows: string[][]
  variablesIndex: VariablesIndex | null
  cvFlagThreshold: number
  moeIndexByEstimate: Map<number, number>
}): DecodeResult {
  const { headers, rows, variablesIndex, cvFlagThreshold, moeIndexByEstimate } =
    opts
  const mergedMoeColumns = new Set(moeIndexByEstimate.values())

  const headerCells: string[] = []
  const legend: string[] = []
  for (let i = 0; i < headers.length; i++) {
    if (mergedMoeColumns.has(i)) continue
    const h = headers[i]
    headerCells.push(moeIndexByEstimate.has(i) ? `${h} (+/- MOE)` : h)
    const label = variablesIndex?.byName.get(h)?.label
    if (label && !GEO_LEVEL_COLUMNS.has(h.toLowerCase()) && h !== 'NAME') {
      legend.push(`  ${h} = ${prettyLabel(label)}`)
    }
  }

  let lowReliabilityCount = 0
  let sentinelHitCount = 0
  const tableLines: string[] = [headerCells.join(' | ')]

  for (const row of rows) {
    const cells: string[] = []
    for (let i = 0; i < headers.length; i++) {
      if (mergedMoeColumns.has(i)) continue
      const raw = row[i]

      if (moeIndexByEstimate.has(i)) {
        const moeRaw = row[moeIndexByEstimate.get(i)!]
        if (isSentinel(raw) || isSentinel(moeRaw)) sentinelHitCount++
        cells.push(
          renderCompactEstimate(raw, moeRaw, cvFlagThreshold, () => {
            lowReliabilityCount++
          }),
        )
        continue
      }

      const sentinel = getSentinelInfo(raw)
      if (sentinel) {
        sentinelHitCount++
        cells.push(sentinel.short)
        continue
      }
      cells.push(raw ?? '')
    }
    tableLines.push(cells.join(' | '))
  }

  const reliabilityFlags: string[] = []
  if (lowReliabilityCount > 0) {
    reliabilityFlags.push(
      `**LOW RELIABILITY:** ${lowReliabilityCount} estimate value(s) in the shown records have ` +
        `CV above ${Math.round(cvFlagThreshold * 100)}% -- flagged inline as [LOW CV=..%]. ` +
        `Treat those cells as MOE bands, not point estimates.`,
    )
  }

  const parts: string[] = [
    `${rows.length} records in compact table format. Columns are delimited by " | "; ` +
      `estimate columns are shown as "estimate +/- MOE" (90% CI).`,
  ]
  if (legend.length > 0) {
    parts.push(`Columns:\n${legend.join('\n')}`)
  }
  parts.push('```\n' + tableLines.join('\n') + '\n```')

  return {
    rendered: parts.join('\n\n'),
    reliabilityFlags,
    geographyRowCount: rows.length,
    sentinelHitCount,
  }
}

// Compact-cell twin of renderEstimateWithMoe: same sentinel and CV logic,
// but returns just the cell text and reports low reliability via callback
// so the caller can aggregate instead of emitting one caveat per cell.
function renderCompactEstimate(
  estimateRaw: string,
  moeRaw: string,
  cvFlagThreshold: number,
  onLowReliability: () => void,
): string {
  const estSentinel = getSentinelInfo(estimateRaw)
  if (estSentinel) return estSentinel.short

  const estimate = Number(estimateRaw)
  if (!Number.isFinite(estimate)) return estimateRaw ?? ''

  const moeSentinel = getSentinelInfo(moeRaw)
  if (moeSentinel) return `${formatNumber(estimate)} +/- ${moeSentinel.short}`

  const moe = Number(moeRaw)
  if (!Number.isFinite(moe) || estimate === 0) {
    return `${formatNumber(estimate)} +/- ${moeRaw}`
  }

  const cv = moe / 1.645 / Math.abs(estimate)
  let suffix = ''
  if (cv > cvFlagThreshold) {
    suffix = ` [LOW CV=${Math.round(cv * 100)}%]`
    onLowReliability()
  }
  return `${formatNumber(estimate)} +/- ${formatNumber(moe)}${suffix}`
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
        `(threshold ${Math.round(cvFlagThreshold * 100)}%) -- too imprecise for ` +
        `a point claim; use the MOE band, not the point estimate.`,
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
