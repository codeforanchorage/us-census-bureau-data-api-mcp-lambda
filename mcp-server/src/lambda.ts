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

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, mcp-session-id',
  'Access-Control-Expose-Headers': 'x-request-id, mcp-session-id',
}

const PROTOCOL_VERSION = '2024-11-05'

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

function getSessionId(
  event: LambdaEvent,
  method: string | undefined,
): string | undefined {
  const fromHeader = Object.entries(event.headers ?? {}).find(
    ([name]) => name.toLowerCase() === 'mcp-session-id',
  )?.[1]

  // Streamable HTTP: the server assigns a session id at initialization (via
  // the mcp-session-id response header) and clients echo it on every
  // subsequent request.
  return fromHeader ?? (method === 'initialize' ? randomUUID() : undefined)
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
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: 'census-api', version: '0.1.0' },
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
