import { MCPServer } from './server.js'

import { FetchAggregateDataTool } from './tools/fetch-aggregate-data.tool.js'
import { FetchDatasetGeographyTool } from './tools/fetch-dataset-geography.tool.js'
import { ListDatasetsTool } from './tools/list-datasets.tool.js'
import { ListSurveyComponentsTool } from './tools/list-survey-components.tool.js'
import { ListSurveyProgramsTool } from './tools/list-survey-programs.tool.js'
import { ListTableVariablesTool } from './tools/list-table-variables.tool.js'
import { ResolveGeographyFipsTool } from './tools/resolve-geography-fips.tool.js'
import { SearchDataTablesTool } from './tools/search-data-tables.tool.js'

import { ComparePlacesPrompt } from './prompts/compare-places.prompt.js'
import { PopulationPrompt } from './prompts/population.prompt.js'
import { SERVER_NAME, SERVER_VERSION } from './version.js'

export function createServer(): MCPServer {
  const mcpServer = new MCPServer(SERVER_NAME, SERVER_VERSION)

  mcpServer.registerPrompt(new PopulationPrompt())
  mcpServer.registerPrompt(new ComparePlacesPrompt())

  mcpServer.registerTool(new FetchAggregateDataTool())
  mcpServer.registerTool(new FetchDatasetGeographyTool())
  mcpServer.registerTool(new ListDatasetsTool())
  mcpServer.registerTool(new ListSurveyComponentsTool())
  mcpServer.registerTool(new ListSurveyProgramsTool())
  mcpServer.registerTool(new ListTableVariablesTool())
  mcpServer.registerTool(new ResolveGeographyFipsTool())
  mcpServer.registerTool(new SearchDataTablesTool())

  return mcpServer
}
