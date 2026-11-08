#!/usr/bin/env node
// Appends table <-> dataset rows to data/concept.csv for new Census vintages.
//
// concept.csv is the only source of the data_table_datasets links that
// search-data-tables reads; the datasets seed picks up new vintages from the
// live catalog by itself, but nothing links their tables until rows land
// here. Each row is one group from the dataset's own groups.json, which
// matches the existing rows exactly (ACSDT1Y2024: 1,440 groups, 1,440 rows,
// identical labels). CONCEPT_ID is a Census-internal id the API does not
// expose and the seed ignores, so appended rows leave it empty.
//
// Rows are written with CRLF, matching the file.
//
// Usage (from mcp-db/):
//   node scripts/append-concepts.mjs ACSDT1Y2025 ACSST1Y2025 ...
//   node scripts/append-concepts.mjs --missing-acs   # list ACS gaps, no writes
//   node scripts/append-concepts.mjs --dry-run ACSDT1Y2025
//
// Dataset ids are the last segment of the catalog identifier (the same
// values as datasets.dataset_id). Plain node, no dependencies. Then reseed:
// `npm run seed` is insert-or-skip throughout, so it is safe on a live DB.

import { readFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CSV = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'concept.csv',
)
// Aggregate ACS families the MCP serves. PUMS (microdata) is unsupported
// and flows/language/one-off products are left to explicit ids.
const ACS_FAMILIES = [
  'ACSDT1Y',
  'ACSDP1Y',
  'ACSST1Y',
  'ACSCP1Y',
  'ACSSE',
  'ACSSPP1Y',
  'ACSDT5Y',
  'ACSDP5Y',
  'ACSST5Y',
  'ACSCP5Y',
]

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const listMissing = args.includes('--missing-acs')
const ids = args.filter((a) => !a.startsWith('--'))

if (!listMissing && ids.length === 0) {
  process.stderr.write('Pass dataset ids (e.g. ACSDT1Y2025) or --missing-acs\n')
  process.exit(2)
}

const csvQuote = (s) => `"${String(s).replace(/"/g, '""')}"`

function existingPairs() {
  const pairs = new Set()
  const datasets = new Set()
  for (const line of readFileSync(CSV, 'utf8').split('\n').slice(1)) {
    // The last two fields are always CONCEPT_STRING and DATASET_STRING.
    const m = /"([^"]*)","([^"]*)"\s*\r?$/.exec(line)
    if (!m) continue
    pairs.add(`${m[1]}|${m[2]}`)
    datasets.add(m[2])
  }
  return { pairs, datasets }
}

async function getJson(url, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (i >= attempts) throw new Error(`${url}: ${err.message}`)
      await new Promise((r) => setTimeout(r, 2000 * i))
    }
  }
}

const catalog = (await getJson('https://api.census.gov/data.json')).dataset
const byId = new Map(catalog.map((d) => [d.identifier.split('/').pop(), d]))
const { pairs, datasets } = existingPairs()

if (listMissing) {
  const missing = [...byId.keys()]
    .filter((id) => ACS_FAMILIES.includes(id.replace(/\d{4}$/, '')))
    .filter((id) => !datasets.has(id))
    .sort()
  process.stdout.write(missing.length ? missing.join('\n') + '\n' : 'none\n')
  process.exit(0)
}

let total = 0
for (const id of ids) {
  const d = byId.get(id)
  if (!d) {
    process.stderr.write(`${id}: not in the live catalog, skipped\n`)
    process.exitCode = 1
    continue
  }
  const endpoint = `${d.c_vintage}/${d.c_dataset.join('/')}`
  const { groups } = await getJson(
    `https://api.census.gov/data/${endpoint}/groups.json`,
  )
  const rows = groups
    .filter((g) => g.name && g.description)
    .filter((g) => !pairs.has(`${g.name}|${id}`))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ['', g.description, g.name, id].map(csvQuote).join(','))
  if (!dryRun && rows.length) appendFileSync(CSV, rows.join('\r\n') + '\r\n')
  rows.forEach((r) => pairs.add(r))
  total += rows.length
  process.stdout.write(
    `${id.padEnd(14)} ${endpoint.padEnd(24)} groups=${groups.length} appended=${rows.length}${dryRun ? ' (dry run)' : ''}\n`,
  )
}
process.stdout.write(`total appended: ${total}\n`)
