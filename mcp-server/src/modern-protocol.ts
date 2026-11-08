// MCP 2026-07-28 ("modern") request handling for the Lambda transport.
//
// 2026-07-28 drops the initialize handshake and sessions: every request
// carries its protocol version (and client info/capabilities) in
// params._meta, mirrored in HTTP headers, and the server answers
// statelessly. This server is dual-era: a request carrying modern _meta is
// served under these rules, while initialize-based clients (Claude on
// 2025-11-25, M365 Copilot GCC on 2024-11-05) keep the legacy path in
// lambda.ts unchanged. See specification/2026-07-28/basic/versioning
// ("Compatibility Matrix") and basic/transports/streamable-http.
//
// The pure functions here decide era and validate headers; lambda.ts owns
// dispatch.

// Versions served statelessly via per-request _meta. Legacy revisions are
// NOT listed: a client cannot use them without initialize, so they do not
// belong in server/discover's supportedVersions or a -32022 `supported` list.
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

// Error codes from the MCP-reserved range (basic/index#error-codes).
export const HEADER_MISMATCH = -32020
export const UNSUPPORTED_PROTOCOL_VERSION = -32022

// Freshness hint for cacheable results (server/discover, tools/list,
// prompts/list). The lists only change with a deploy, and nothing in them
// is user-specific, so they are cacheable publicly for an hour.
export const LIST_TTL_MS = 3_600_000
export const CACHEABLE_METHODS = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
])

// Methods that carry an Mcp-Name header mirroring params.name.
const NAMED_METHODS = new Set(['tools/call', 'prompts/get'])

export function isModernVersion(version: unknown): boolean {
  return (
    typeof version === 'string' &&
    (MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version)
  )
}

export function requestMeta(
  params: unknown,
): Record<string, unknown> | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const meta = (params as { _meta?: unknown })._meta
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined
}

// A request is modern when its body carries the modern _meta version, or
// its MCP-Protocol-Version header names a modern revision (a body missing
// the _meta it then requires is a HeaderMismatch, not a legacy request).
export function isModernRequest(
  headerVersion: string | undefined,
  params: unknown,
): boolean {
  return (
    requestMeta(params)?.[META_PROTOCOL_VERSION] !== undefined ||
    isModernVersion(headerVersion)
  )
}

// RFC 9110 field-value characters: visible ASCII, space, horizontal tab.
const HEADER_SAFE = /^[\x20-\x7E\t]*$/
const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/

// Decodes an Mcp-Name value, honouring the =?base64?...?= sentinel. Returns
// undefined for a value that is not a valid header value or sentinel.
export function decodeHeaderValue(raw: string): string | undefined {
  if (!HEADER_SAFE.test(raw)) return undefined
  if (!raw.startsWith('=?base64?')) return raw
  const m = BASE64_SENTINEL.exec(raw)
  if (!m || m[1].length % 4 !== 0) return undefined
  return Buffer.from(m[1], 'base64').toString('utf8')
}

export type ModernRejection = {
  status: number
  code: number
  message: string
  data?: Record<string, unknown>
}

export type ModernHeaders = {
  protocolVersion: string | undefined
  method: string | undefined
  name: string | undefined
}

// Server Validation (streamable-http#server-validation): every mirrored
// header must be present, well-formed and equal to its body value, else
// 400 + HeaderMismatch. Then the version must be one we serve, else
// 400 + UnsupportedProtocolVersionError listing what we do serve.
export function validateModernRequest(
  headers: ModernHeaders,
  method: string | undefined,
  params: unknown,
): ModernRejection | null {
  const mismatch = (message: string): ModernRejection => ({
    status: 400,
    code: HEADER_MISMATCH,
    message: `Header mismatch: ${message}`,
  })

  const metaVersion = requestMeta(params)?.[META_PROTOCOL_VERSION]
  if (headers.protocolVersion === undefined) {
    return mismatch('MCP-Protocol-Version header is required')
  }
  if (!HEADER_SAFE.test(headers.protocolVersion)) {
    return mismatch('MCP-Protocol-Version header contains invalid characters')
  }
  if (typeof metaVersion !== 'string') {
    return mismatch(
      `params._meta["${META_PROTOCOL_VERSION}"] is required with MCP-Protocol-Version ${headers.protocolVersion}`,
    )
  }
  if (headers.protocolVersion !== metaVersion) {
    return mismatch(
      `MCP-Protocol-Version header value '${headers.protocolVersion}' does not match body value '${metaVersion}'`,
    )
  }

  if (headers.method === undefined) {
    return mismatch('Mcp-Method header is required')
  }
  if (headers.method !== method) {
    return mismatch(
      `Mcp-Method header value '${headers.method}' does not match body value '${String(method)}'`,
    )
  }

  if (method !== undefined && NAMED_METHODS.has(method)) {
    const bodyName = (params as { name?: unknown } | undefined)?.name
    if (headers.name === undefined) {
      return mismatch(`Mcp-Name header is required for ${method}`)
    }
    const decoded = decodeHeaderValue(headers.name)
    if (decoded === undefined) {
      return mismatch('Mcp-Name header value is malformed')
    }
    if (decoded !== bodyName) {
      return mismatch(
        `Mcp-Name header value '${decoded}' does not match body value '${String(bodyName)}'`,
      )
    }
  }

  if (!isModernVersion(metaVersion)) {
    return {
      status: 400,
      code: UNSUPPORTED_PROTOCOL_VERSION,
      message: 'Unsupported protocol version',
      data: {
        supported: [...MODERN_PROTOCOL_VERSIONS],
        requested: metaVersion,
      },
    }
  }
  return null
}

// Every modern result carries resultType and the server's identity;
// cacheable results add the freshness hints CacheableResult requires.
export function modernResult(
  method: string,
  result: unknown,
  serverInfo: { name: string; version: string },
): Record<string, unknown> {
  const base = (result ?? {}) as Record<string, unknown>
  const existingMeta =
    typeof base._meta === 'object' && base._meta !== null
      ? (base._meta as Record<string, unknown>)
      : {}
  return {
    ...base,
    resultType: 'complete',
    ...(CACHEABLE_METHODS.has(method)
      ? { ttlMs: LIST_TTL_MS, cacheScope: 'public' }
      : {}),
    _meta: { ...existingMeta, [META_SERVER_INFO]: serverInfo },
  }
}
