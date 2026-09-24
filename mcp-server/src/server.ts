import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  CallToolResult,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { SERVER_INSTRUCTIONS } from './instructions.js'
import { MCPPrompt, PromptRegistry } from './prompts/base.prompt.js'
import {
  MCPTool,
  READ_ONLY_ANNOTATIONS,
  ToolRegistry,
} from './tools/base.tool.js'

export class MCPServer {
  private server: Server
  private toolRegistry = new ToolRegistry()
  private promptRegistry = new PromptRegistry()

  constructor(name: string, version: string) {
    this.server = new Server(
      { name, version },
      {
        capabilities: {
          tools: {},
          prompts: {},
        },
        instructions: SERVER_INSTRUCTIONS,
      },
    )
    this.setupHandlers()
  }

  private setupHandlers() {
    // Tool handlers
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return await this.getTools()
    })

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Our ToolResponse is structurally a CallToolResult; the SDK's
      // passthrough zod type just can't see that through an interface.
      return (await this.handleToolCall(request)) as CallToolResult
    })

    // Prompt handlers
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return await this.getPrompts()
    })

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return await this.handleGetPrompt(request)
    })
  }

  getTools() {
    return {
      tools: this.toolRegistry.getAll().map((tool) => ({
        name: tool.name,
        // Top-level title (2025-06-18+), not annotations.title: clients
        // resolve display precedence as title -> annotations.title -> name.
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        // Omit outputSchema entirely for tools that do not declare one --
        // an empty/placeholder schema would be a binding promise.
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        annotations: READ_ONLY_ANNOTATIONS,
      })),
    }
  }

  async handleToolCall(request: {
    params: { name: string; arguments?: unknown }
  }) {
    const toolName = request.params.name
    const tool = this.toolRegistry.get(toolName)

    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`)
    }

    // Bad arguments come back as a tool execution error (isError), not a
    // JSON-RPC -32602: the spec routes input validation failures through
    // the result so the model sees them and can correct its next call,
    // whereas many clients surface protocol errors to the user and never
    // show them to the model. Unknown tools above stay protocol errors.
    const parsed = tool.argsSchema.safeParse(request.params.arguments)
    if (!parsed.success) {
      console.warn(`Invalid arguments for ${toolName}: ${parsed.error.message}`)
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Invalid arguments for ${toolName}:\n` +
              `${formatZodIssues(parsed.error)}\n\n` +
              `Correct these arguments and call ${toolName} again; its inputSchema lists the expected fields.`,
          },
        ],
        isError: true,
      }
    }
    return await tool.handler(parsed.data)
  }

  registerTool<T extends object>(tool: MCPTool<T>) {
    this.toolRegistry.register(tool)
  }

  getPrompts() {
    return {
      prompts: this.promptRegistry.getAll().map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments,
      })),
    }
  }

  async handleGetPrompt(request: {
    params: { name: string; arguments?: unknown }
  }) {
    const promptName = request.params.name
    const prompt = this.promptRegistry.get(promptName)

    if (!prompt) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown prompt: ${promptName}`,
      )
    }

    try {
      const args = request.params.arguments || {}
      const validatedArgs = prompt.argsSchema.parse(args)

      const result = await prompt.handler(validatedArgs)

      return {
        description: result.description,
        messages: result.messages,
      }
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid arguments:\n${formatZodIssues(err)}`,
        )
      }
      throw err
    }
  }

  registerPrompt<T extends object>(prompt: MCPPrompt<T>) {
    this.promptRegistry.register(prompt)
  }

  async connect(transport: StdioServerTransport) {
    await this.server.connect(transport)
  }
}

// One "- field: problem" line per issue, instead of ZodError.message's
// pretty-printed JSON dump. Nested paths are dotted (get.variables);
// an issue on the arguments object itself is labelled as such.
export function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map(
      (issue) =>
        `- ${issue.path.length > 0 ? issue.path.join('.') : '(arguments)'}: ${issue.message}`,
    )
    .join('\n')
}
