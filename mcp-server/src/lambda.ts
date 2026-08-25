process.env.DEBUG_LOGS = process.env.DEBUG_LOGS ?? 'true'

if (process.env.DEBUG_LOGS !== 'true') {
  console.log = () => {}
  console.info = () => {}
  console.warn = () => {}
}

import { randomUUID } from 'node:crypto'

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'
import { z } from 'zod'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'

import { createServer } from './createServer.js'
import { MCPServer } from './server.js'
import { DatabaseService } from './services/database.service.js'
import { SERVER_NAME, SERVER_VERSION } from './version.js'

type LambdaEvent = {
  version?: string
  httpMethod?: string
  path?: string
  rawPath?: string
  requestContext?: {
    http?: { method?: string; path?: string }
  }
  headers?: Record<string, string | undefined>
  body?: string | null
  isBase64Encoded?: boolean
}

type LambdaResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
}

type JsonRpcRequest = {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

// Browser origins allowed to drive this server. This is the Streamable
// HTTP transport's DNS-rebinding defence: a disallowed Origin gets HTTP
// 403, on the POST path AND the OPTIONS preflight -- merely withholding
// CORS headers is not the same thing as refusing the request. Requests
// with no Origin header (native MCP clients, curl, Lambda console tests)
// are unaffected and stay allowed.
const ALLOWED_ORIGINS = new Set([
  'https://claude.ai',
  'https://claude.com',
  // MCP Inspector's local dev proxy.
  'http://localhost:6274',
  'http://127.0.0.1:6274',
])

// Access-Control-Allow-Origin is added per-response by applyCorsOrigin --
// it echoes the (allowed) requesting origin instead of '*'.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'content-type, mcp-session-id, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'x-request-id, mcp-session-id',
}

function applyCorsOrigin(
  response: LambdaResponse,
  origin: string | undefined,
): LambdaResponse {
  if (origin !== undefined) {
    response.headers['Access-Control-Allow-Origin'] = origin
    response.headers['Vary'] = 'Origin'
  }
  return response
}

function originRejection(origin: string): LambdaResponse {
  // Deliberately no CORS headers: the browser must treat this as a
  // cross-origin failure, and the 403 stops non-CORS-enforcing callers too.
  return {
    statusCode: 403,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: `Origin not allowed: ${origin}` },
    }),
  }
}

// Protocol revisions this server speaks, newest first. The tools/prompts
// wire format is identical across all four -- each newer revision's
// additions (elicitation, structured-output extras, tasks) are optional
// and unused here -- so supporting a revision means nothing more than
// echoing it back in the initialize negotiation. 2024-11-05 stays in the
// list deliberately: M365 Copilot (GCC) is a first-class consumer and its
// connector still opens with the oldest revision.
//
// Do NOT add 2026-07-28. That revision replaces the initialize handshake
// with per-request _meta plus a mandatory server/discover RPC -- adopting
// it is a dual-era transport migration, not a version-string addition.
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0]

function isSupportedProtocolVersion(version: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version)
}

// Spec negotiation: echo the client's requested revision when we support
// it; otherwise answer with the latest we do support and let the client
// decide whether to proceed.
function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && isSupportedProtocolVersion(requested)) {
    return requested
  }
  return LATEST_PROTOCOL_VERSION
}

let serverPromise: Promise<MCPServer> | null = null

async function loadSecrets(): Promise<void> {
  if (process.env.DATABASE_URL && process.env.CENSUS_API_KEY) return

  const secretArn = process.env.DB_SECRET_ARN
  if (!secretArn) {
    // Local dev: fall through without fetching; caller is expected to have
    // DATABASE_URL and CENSUS_API_KEY set via the shell or .env.
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DB_SECRET_ARN is not set and no DATABASE_URL fallback is configured',
      )
    }
    return
  }

  const region = process.env.AWS_REGION ?? 'us-west-2'
  const client = new SecretsManagerClient({ region })
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  )

  if (!result.SecretString) {
    throw new Error(`Secret ${secretArn} has no SecretString payload`)
  }

  const parsed = JSON.parse(result.SecretString) as {
    username?: string
    password?: string
    host?: string
    port?: number | string
    dbname?: string
    census_api_key?: string
  }

  if (!process.env.DATABASE_URL) {
    if (
      !parsed.username ||
      !parsed.password ||
      !parsed.host ||
      !parsed.dbname
    ) {
      throw new Error(
        `Secret ${secretArn} is missing required keys (username, password, host, dbname)`,
      )
    }

    const port = parsed.port ?? 5432
    process.env.DATABASE_URL = `postgresql://${encodeURIComponent(parsed.username)}:${encodeURIComponent(
      parsed.password,
    )}@${parsed.host}:${port}/${parsed.dbname}`
  }

  if (!process.env.CENSUS_API_KEY && parsed.census_api_key) {
    process.env.CENSUS_API_KEY = parsed.census_api_key
  }
}

async function getServer(): Promise<MCPServer> {
  if (!serverPromise) {
    serverPromise = (async () => {
      await loadSecrets()
      // Touch DatabaseService so pool initializes on cold start, not first query
      DatabaseService.getInstance()
      return createServer()
    })()
  }
  return serverPromise
}

function extractMethodAndPath(event: LambdaEvent): {
  method: string
  path: string
} {
  if (event.requestContext?.http) {
    return {
      method: event.requestContext.http.method ?? 'GET',
      path: event.requestContext.http.path ?? event.rawPath ?? '/',
    }
  }
  return {
    method: event.httpMethod ?? 'GET',
    path: event.path ?? event.rawPath ?? '/',
  }
}

function jsonResponse(
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): LambdaResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  }
}

// One JSON line per request, consumed by the mcp-fleet-usage CloudWatch
// dashboard (Logs Insights fields: mcp_session_id, jsonrpc_method,
// jsonrpc_params.name, jsonrpc_params.clientInfo.name). Written straight to
// stdout so it flows even when DEBUG_LOGS is off. Never include tool
// arguments here — they can contain user query content.
function logUsage(
  sessionId: string | undefined,
  method: string,
  params: unknown,
): void {
  const { name, clientInfo } = (params ?? {}) as {
    name?: unknown
    clientInfo?: { name?: unknown; version?: unknown }
  }

  process.stdout.write(
    `${JSON.stringify({
      mcp_session_id: sessionId,
      jsonrpc_method: method,
      jsonrpc_params: {
        ...(typeof name === 'string' ? { name } : {}),
        ...(clientInfo
          ? {
              clientInfo: {
                name: clientInfo.name,
                version: clientInfo.version,
              },
            }
          : {}),
      },
    })}\n`,
  )
}

function getHeader(event: LambdaEvent, name: string): string | undefined {
  return Object.entries(event.headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === name,
  )?.[1]
}

function getSessionId(
  event: LambdaEvent,
  method: string | undefined,
): string | undefined {
  const fromHeader = getHeader(event, 'mcp-session-id')

  // Streamable HTTP: the server assigns a session id at initialization (via
  // the mcp-session-id response header) and clients echo it on every
  // subsequent request.
  return fromHeader ?? (method === 'initialize' ? randomUUID() : undefined)
}

// Since revision 2025-06-18, Streamable HTTP clients send an
// MCP-Protocol-Version header on every post-handshake request. Absent means
// an older client -- the spec says assume 2025-03-26, which we support, so
// pass through untouched. Present but unrecognized gets HTTP 400 with a
// JSON-RPC -32600 -- deliberately NOT the 2026-07-28-era -32022
// UnsupportedProtocolVersionError, which would make a dual-era client retry
// the new server/discover handshake; 400/-32600 makes it read us as a
// legacy server and fall back to initialize, which is what we support.
function checkProtocolVersionHeader(
  event: LambdaEvent,
  id: string | number | null | undefined,
): LambdaResponse | null {
  const requested = getHeader(event, 'mcp-protocol-version')
  if (requested === undefined || isSupportedProtocolVersion(requested)) {
    return null
  }
  return errorResponse(
    id ?? null,
    -32600,
    `Unsupported MCP-Protocol-Version: ${requested}. ` +
      `Supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
    400,
  )
}

function errorResponse(
  id: string | number | null | undefined,
  code: number,
  message: string,
  statusCode = 200,
): LambdaResponse {
  return jsonResponse(statusCode, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  })
}

async function dispatch(
  server: MCPServer,
  body: JsonRpcRequest,
): Promise<LambdaResponse> {
  const { id, method, params } = body

  if (!method) {
    return errorResponse(id, -32600, 'Missing method')
  }

  // Notifications (no id) expect no response body
  const isNotification = id === undefined || id === null

  try {
    let result: unknown

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: negotiateProtocolVersion(
            (params as { protocolVersion?: unknown } | undefined)
              ?.protocolVersion,
          ),
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }
        break

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return jsonResponse(202, {})

      case 'ping':
        result = {}
        break

      case 'tools/list':
        result = server.getTools()
        break

      case 'tools/call':
        result = await server.handleToolCall({
          params: (params ?? {}) as { name: string; arguments?: unknown },
        })
        break

      case 'prompts/list':
        result = server.getPrompts()
        break

      case 'prompts/get':
        result = await server.handleGetPrompt({
          params: (params ?? {}) as { name: string; arguments?: unknown },
        })
        break

      default:
        return errorResponse(id, -32601, `Method not found: ${method}`)
    }

    if (isNotification) {
      return jsonResponse(202, {})
    }

    return jsonResponse(200, { jsonrpc: '2.0', id, result })
  } catch (err) {
    if (err instanceof McpError) {
      return errorResponse(id, err.code, err.message)
    }
    if (err instanceof z.ZodError) {
      return errorResponse(id, ErrorCode.InvalidParams, err.message)
    }
    const message = err instanceof Error ? err.message : String(err)
    return errorResponse(id, -32603, `Internal error: ${message}`)
  }
}

export async function handler(event: LambdaEvent): Promise<LambdaResponse> {
  const origin = getHeader(event, 'origin')
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
    return originRejection(origin)
  }
  return applyCorsOrigin(await routeRequest(event), origin)
}

async function routeRequest(event: LambdaEvent): Promise<LambdaResponse> {
  const { method, path } = extractMethodAndPath(event)

  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: { ...CORS_HEADERS, 'Access-Control-Max-Age': '86400' },
      body: '',
    }
  }

  if (method !== 'POST') {
    return errorResponse(null, -32600, `Method not allowed: ${method}`, 405)
  }

  if (path !== '/mcp' && !path.endsWith('/mcp')) {
    return errorResponse(null, -32601, `Not found: ${path}`, 404)
  }

  let rawBody = event.body ?? ''
  if (event.isBase64Encoded && rawBody) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf8')
  }

  let parsed: JsonRpcRequest
  try {
    parsed = rawBody ? (JSON.parse(rawBody) as JsonRpcRequest) : {}
  } catch {
    return errorResponse(null, -32700, 'Parse error: invalid JSON')
  }

  const versionRejection = checkProtocolVersionHeader(event, parsed.id)
  if (versionRejection) {
    return versionRejection
  }

  const sessionId = getSessionId(event, parsed.method)
  if (parsed.method) {
    logUsage(sessionId, parsed.method, parsed.params)
  }

  try {
    const server = await getServer()
    const response = await dispatch(server, parsed)
    if (sessionId) {
      response.headers['mcp-session-id'] = sessionId
    }
    return response
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return errorResponse(
      parsed.id ?? null,
      -32603,
      `Initialization failed: ${message}`,
      500,
    )
  }
}
