const enableDebugLogs = process.env.DEBUG_LOGS === 'true'

if (!enableDebugLogs) {
  console.log = () => {}
  console.info = () => {}
  console.warn = () => {}
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './createServer.js'

async function main() {
  const mcpServer = createServer()
  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
}

main().catch(console.error)
