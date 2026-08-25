import { Tool } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { ToolResponse } from '../types/base.types.js'

// Behaviour hints shown to clients in tools/list. Every tool here is a
// read-only query, so the annotations are uniform. idempotentHint is
// deliberately absent: the MCP schema defines it as meaningful only when
// readOnlyHint is false, so emitting it alongside readOnlyHint: true would
// be noise at best and contradictory at worst (pinned by a test).
export const READ_ONLY_ANNOTATIONS: {
  readOnlyHint: boolean
  openWorldHint: boolean
} = {
  readOnlyHint: true,
  // All five tools ultimately answer from the Census Bureau's published
  // data (directly or via our seeded copy of it), an external system.
  openWorldHint: true,
}

export interface MCPTool<Args extends object = object> {
  name: string
  // Human-readable display name. Clients resolve display precedence as
  // title -> annotations.title -> name; without it, UIs fall back to the
  // wire identifier (e.g. "fetch-aggregate-data").
  title: string
  description: string
  inputSchema: Tool['inputSchema']
  // JSON schema for structuredContent, emitted as outputSchema in
  // tools/list. Optional: a tool without one is untouched on the wire.
  // A declared outputSchema is BINDING -- the server MUST conform and
  // clients may validate -- so never declare a constraint real Census
  // data can violate.
  outputSchema?: Tool['inputSchema']
  argsSchema: z.ZodSchema<Args, z.ZodTypeDef, Args>
  handler: (args: Args) => Promise<ToolResponse>
}

interface StoredMCPTool {
  name: string
  title: string
  description: string
  inputSchema: Tool['inputSchema']
  outputSchema?: Tool['inputSchema']
  argsSchema: z.ZodSchema<object, z.ZodTypeDef, object>
  handler: (args: object) => Promise<ToolResponse>
}

export abstract class BaseTool<Args extends object> implements MCPTool<Args> {
  abstract name: string
  abstract title: string
  abstract description: string
  abstract inputSchema: Tool['inputSchema']
  outputSchema?: Tool['inputSchema']
  abstract get argsSchema(): z.ZodType<Args, z.ZodTypeDef, Args>
  protected abstract toolHandler(
    args: Args,
    apiKey?: string,
  ): Promise<ToolResponse>
  abstract readonly requiresApiKey: boolean

  async handler(args: Args): Promise<ToolResponse> {
    try {
      let apiKey: string | undefined

      // Only check for API key if the tool requires it
      if (this.requiresApiKey) {
        apiKey = process.env.CENSUS_API_KEY

        if (!apiKey) {
          return this.createErrorResponse('Error: CENSUS_API_KEY is not set.')
        }
      }

      return await this.toolHandler(args, apiKey)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      return this.createErrorResponse(`Unexpected error: ${errorMessage}`)
    }
  }

  // Tool-level failure: isError marks it as the spec's in-band error
  // channel -- without the flag a client cannot tell an error message
  // from data. Error results deliberately carry no structuredContent;
  // outputSchema binds successful results only.
  protected createErrorResponse(message: string): ToolResponse {
    return {
      content: [
        {
          type: 'text' as const,
          text: message,
        },
      ],
      isError: true,
    }
  }

  protected createSuccessResponse(
    text: string,
    structuredContent?: Record<string, unknown>,
  ): ToolResponse {
    return {
      content: [
        {
          type: 'text' as const,
          text,
        },
      ],
      ...(structuredContent !== undefined ? { structuredContent } : {}),
    }
  }
}

export class ToolRegistry {
  private tools = new Map<string, StoredMCPTool>()

  register<T extends object>(tool: MCPTool<T>): void {
    // Store as type-erased version
    const storedTool: StoredMCPTool = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      argsSchema: tool.argsSchema as z.ZodSchema<object, z.ZodTypeDef, object>,
      handler: tool.handler as (args: object) => Promise<ToolResponse>,
    }
    this.tools.set(tool.name, storedTool)
  }

  getAll(): StoredMCPTool[] {
    return Array.from(this.tools.values())
  }

  get(name: string): StoredMCPTool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }
}
