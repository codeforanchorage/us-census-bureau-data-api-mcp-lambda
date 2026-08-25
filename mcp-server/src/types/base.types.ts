import { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

type JsonContent = {
  type: 'json'
  json: object
}

export type ToolContent = TextContent | JsonContent

// A machine-readable qualification attached to a tool result. The same
// list drives both the rendered prose and the structuredContent caveats
// array, so the two channels cannot drift: `code` is the stable key a
// caller can branch on, `message` is the human sentence.
export interface ToolCaveat {
  code: string
  message: string
}

// What a tool handler returns. structuredContent mirrors the text content
// for tools that declare an outputSchema; isError marks a tool-level
// failure (the spec's in-band error channel -- without it a client cannot
// tell an error message from data).
export interface ToolResponse {
  content: ToolContent[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export interface StoredMCPTool {
  name: string
  description: string
  inputSchema: Tool['inputSchema']
  argsSchema: z.ZodSchema<object, z.ZodTypeDef, object>
  handler: (args: object) => Promise<ToolResponse>
}
