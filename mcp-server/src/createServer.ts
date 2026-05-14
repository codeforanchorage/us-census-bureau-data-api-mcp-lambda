import { MCPServer } from './server.js'

import { FetchAggregateDataTool } from './tools/fetch-aggregate-data.tool.js'
import { FetchDatasetGeographyTool } from './tools/fetch-dataset-geography.tool.js'
import { ListDatasetsTool } from './tools/list-datasets.tool.js'
import { ResolveGeographyFipsTool } from './tools/resolve-geography-fips.tool.js'
import { SearchDataTablesTool } from './tools/search-data-tables.tool.js'

import { PopulationPrompt } from './prompts/population.prompt.js'

export function createServer(): MCPServer {
  const mcpServer = new MCPServer('census-api', '0.1.0')

  mcpServer.registerPrompt(new PopulationPrompt())

  mcpServer.registerTool(new FetchAggregateDataTool())
  mcpServer.registerTool(new FetchDatasetGeographyTool())
  mcpServer.registerTool(new ListDatasetsTool())
  mcpServer.registerTool(new ResolveGeographyFipsTool())
  mcpServer.registerTool(new SearchDataTablesTool())

  return mcpServer
}
