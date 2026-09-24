// Single source of truth for the server identity reported in the MCP
// initialize handshake (serverInfo). Bump SERVER_VERSION on every deployable
// behaviour change -- it is the only way to tell from a connected client
// which build is actually running. lambda.ts and createServer.ts both used
// to hardcode their own copy of '0.1.0', which made the wire version
// meaningless.
export const SERVER_NAME = 'census-api'
export const SERVER_VERSION = '0.4.0'
