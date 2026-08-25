#!/usr/bin/env node
// Production smoke test for the Census MCP endpoint.
//
// Asserts CAPABILITIES, not scope: the database is reseeded periodically
// and every figure moves, so nothing here pins a population number or a
// row count. What it does pin:
//   - the transport contract (protocol negotiation, Origin allowlist,
//     header validation, ping shape)
//   - tools/list metadata (titles, outputSchema, annotations)
//   - structuredContent present and honest on BOTH a hit and a miss
//   - sentinel values never appearing as bare numbers in structured data
//   - the API key never appearing anywhere in a response
//
// Usage: node scripts/smoke-prod.mjs [base-url]
//   default base-url: https://us-census.codeforanchorage.org/mcp

const BASE_URL = process.argv[2] ?? 'https://us-census.codeforanchorage.org/mcp'

const SENTINEL_NUMBERS = [
  -999999999, -888888888, -666666666, -555555555, -333333333, -222222222,
  -111111111,
]

let failures = 0
let passes = 0

function check(name, ok, detail = '') {
  if (ok) {
    passes++
    console.log(`  PASS  ${name}`)
  } else {
    failures++
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}

async function post(body, headers = {}) {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* non-JSON body (e.g. WAF page) */
  }
  return { status: res.status, json }
}

function rpc(id, method, params) {
  return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
}

async function transportChecks() {
  console.log('\n== Transport ==')

  const ping = await post(rpc(1, 'ping'))
  check('ping (no Origin) returns 200', ping.status === 200)
  check(
    'ping result is the empty object (spec shape)',
    JSON.stringify(ping.json?.result) === '{}',
    JSON.stringify(ping.json?.result),
  )

  const allowed = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://claude.ai',
    },
    body: JSON.stringify(rpc(2, 'ping')),
  })
  check('Origin https://claude.ai served 200', allowed.status === 200)
  check(
    'allowed Origin echoed back (no wildcard)',
    allowed.headers.get('access-control-allow-origin') === 'https://claude.ai',
    String(allowed.headers.get('access-control-allow-origin')),
  )

  const evil = await post(rpc(3, 'ping'), { Origin: 'https://evil.example' })
  check('Origin https://evil.example refused with 403', evil.status === 403)

  const badVersion = await post(rpc(4, 'ping'), {
    'MCP-Protocol-Version': '2026-07-28',
  })
  check(
    'unrecognized MCP-Protocol-Version -> 400',
    badVersion.status === 400,
    String(badVersion.status),
  )
  check(
    '... with JSON-RPC -32600',
    badVersion.json?.error?.code === -32600,
    JSON.stringify(badVersion.json?.error),
  )

  const goodVersion = await post(rpc(5, 'ping'), {
    'MCP-Protocol-Version': '2025-11-25',
  })
  check('MCP-Protocol-Version 2025-11-25 -> 200', goodVersion.status === 200)

  const get = await fetch(BASE_URL, { method: 'GET' })
  check(
    'GET /mcp is refused (403 at the gateway / 405 at the Lambda)',
    get.status === 403 || get.status === 405,
    String(get.status),
  )

  const unknown = await post(rpc(6, 'server/discover'))
  check(
    'unknown method -> -32601',
    unknown.json?.error?.code === -32601,
    JSON.stringify(unknown.json?.error),
  )
}

async function initializeChecks() {
  console.log('\n== Initialize ==')
  const init = await post(
    rpc(10, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'smoke-prod', version: '1' },
    }),
  )
  check(
    'negotiates the requested 2025-11-25',
    init.json?.result?.protocolVersion === '2025-11-25',
    init.json?.result?.protocolVersion,
  )
  check(
    'serverInfo carries a version (build identifiable)',
    typeof init.json?.result?.serverInfo?.version === 'string' &&
      init.json.result.serverInfo.version !== '0.1.0',
    init.json?.result?.serverInfo?.version,
  )

  const legacy = await post(
    rpc(11, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-prod', version: '1' },
    }),
  )
  check(
    'still speaks 2024-11-05 for legacy clients (Copilot GCC)',
    legacy.json?.result?.protocolVersion === '2024-11-05',
  )
}

async function toolsListChecks() {
  console.log('\n== tools/list ==')
  const list = await post(rpc(20, 'tools/list'))
  const tools = list.json?.result?.tools ?? []
  check('lists 5 tools', tools.length === 5, String(tools.length))
  check(
    'every tool has a top-level title',
    tools.every((t) => typeof t.title === 'string' && t.title.length > 0),
  )
  check(
    'every tool declares an outputSchema',
    tools.every((t) => t.outputSchema && t.outputSchema.type === 'object'),
  )
  check(
    'every tool is annotated read-only, no idempotentHint',
    tools.every(
      (t) =>
        t.annotations?.readOnlyHint === true &&
        !('idempotentHint' in (t.annotations ?? {})),
    ),
  )
}

async function callTool(id, name, args) {
  const res = await post(
    rpc(id, 'tools/call', { name, arguments: args }),
  )
  return res.json?.result
}

function textOf(result) {
  return result?.content?.map((c) => c.text ?? '').join('\n') ?? ''
}

function sentinelNumbersIn(value) {
  const hits = []
  JSON.stringify(value, (key, v) => {
    if (typeof v === 'number' && SENTINEL_NUMBERS.includes(v)) hits.push(v)
    return v
  })
  return hits
}

async function structuredChecks() {
  console.log('\n== structuredContent: hit ==')
  const hit = await callTool(30, 'resolve-geography-fips', {
    geography_name: 'Anchorage',
  })
  check('resolve hit is not an error', hit && hit.isError !== true)
  const sc = hit?.structuredContent
  check('structuredContent present on a hit', !!sc)
  check(
    'at least one record with a for= string',
    Array.isArray(sc?.records) &&
      sc.records.length >= 1 &&
      typeof sc.records[0].for === 'string',
  )
  check(
    'total_count is a positive integer',
    Number.isInteger(sc?.total_count) && sc.total_count >= 1,
  )
  const hitText = textOf(hit)
  check(
    'every structured caveat message appears in the text',
    (sc?.caveats ?? []).every((c) => hitText.includes(c.message)),
  )

  console.log('\n== structuredContent: miss ==')
  const miss = await callTool(31, 'resolve-geography-fips', {
    geography_name: 'Zzyzx Qwertyuiop Nowhere',
  })
  const mc = miss?.structuredContent
  check('structuredContent present on a miss', !!mc)
  check(
    'miss reports total_count 0 (known zero, not null)',
    mc?.total_count === 0,
    String(mc?.total_count),
  )
  check(
    'miss carries a NO_MATCH caveat',
    (mc?.caveats ?? []).some((c) => c.code === 'NO_MATCH'),
  )

  console.log('\n== structuredContent: search ==')
  const search = await callTool(32, 'search-data-tables', {
    label_query: 'housing units',
    api_endpoint: 'acs/acs5',
    limit: 5,
  })
  const sSc = search?.structuredContent
  check('search structuredContent present', !!sSc)
  check(
    'search records carry string table ids',
    (sSc?.records ?? []).every((r) => typeof r.data_table_id === 'string'),
  )

  console.log('\n== structuredContent: aggregate data ==')
  const agg = await callTool(33, 'fetch-aggregate-data', {
    dataset: 'acs/acs5',
    year: 2023,
    get: { variables: ['B25001_001E'] },
    for: 'county:020',
    in: 'state:02',
  })
  check('aggregate call is not an error', agg && agg.isError !== true, textOf(agg).slice(0, 200))
  const aSc = agg?.structuredContent
  check('aggregate structuredContent present', !!aSc)
  check(
    'source carries dataset + vintage + citation_url',
    typeof aSc?.source?.dataset === 'string' &&
      typeof aSc?.source?.vintage === 'string' &&
      typeof aSc?.source?.citation_url === 'string',
  )
  check(
    'citation_url is key-redacted',
    aSc?.source?.citation_url?.includes('key=REDACTED'),
  )
  const record = aSc?.records?.[0]
  const estimateCell = record?.cells?.find(
    (c) => c.variable === 'B25001_001E',
  )
  check(
    'estimate cell carries value AND its MOE together',
    estimateCell &&
      (typeof estimateCell.value === 'number' ||
        estimateCell.annotation !== null) &&
      'moe' in estimateCell,
  )
  check(
    'geography FIPS codes are strings',
    (record?.geography?.codes ?? []).every((c) => typeof c.code === 'string'),
  )
  check(
    'no sentinel value appears as a bare number in structured data',
    sentinelNumbersIn(aSc).length === 0,
    JSON.stringify(sentinelNumbersIn(aSc)),
  )
  check(
    'every aggregate caveat message appears in the text',
    (aSc?.caveats ?? []).every((c) => textOf(agg).includes(c.message)),
  )

  console.log('\n== key redaction sweep ==')
  const everything = JSON.stringify([hit, miss, search, agg])
  check(
    'no response contains an unredacted key= parameter',
    !/key=(?!REDACTED)[A-Za-z0-9]/.test(everything),
  )
}

async function main() {
  console.log(`Census MCP smoke test against ${BASE_URL}`)
  await transportChecks()
  await initializeChecks()
  await toolsListChecks()
  await structuredChecks()
  console.log(`\n${passes} passed, ${failures} failed`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
