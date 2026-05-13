import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
  Mock,
} from 'vitest'
import { TextContent } from '@modelcontextprotocol/sdk/types.js'

vi.mock('../../../src/services/database.service.js', () => ({
  DatabaseService: {
    getInstance: vi.fn(),
  },
}))

import {
  validateResponseStructure,
  validateToolStructure,
} from '../../helpers/test-utils'

import { DatabaseService } from '../../../src/services/database.service.js'
import {
  SearchDataTablesTool,
  toolDescription,
} from '../../../src/tools/search-data-tables.tool'
import { DataTableSearchResultRow } from '../../../src/types/data-table.types'

const byIdArgs = { data_table_id: 'B16005' }
const byLabelArgs = { label_query: 'language spoken at home' }
const byApiEndpointArgs = { api_endpoint: 'acs/acs1' }
const allParamsArgs = {
  data_table_id: 'B16005',
  label_query: 'language spoken at home',
  api_endpoint: 'acs/acs1',
  limit: 10,
}

const mockDataTables: DataTableSearchResultRow[] = [
  {
    data_table_id: 'B16005',
    label: 'Nativity By Language Spoken At Home By Ability To Speak English',
    component: 'American Community Survey - ACS 1-Year Estimates',
    datasets: {
      '2009': ['acs/acs1'],
      '2010': ['acs/acs1'],
    },
  },
  {
    data_table_id: 'B16005D',
    label: 'Nativity By Language Spoken At Home By Ability To Speak English',
    component: 'American Community Survey - ACS 1-Year Estimates',
    datasets: {
      '2009': ['acs/acs1'],
      '2010': ['acs/acs1'],
    },
  },
]

function getTextContent(
  response: Awaited<ReturnType<SearchDataTablesTool['handler']>>,
  index = 0,
): TextContent {
  const item = response.content[index]
  if (item.type !== 'text') {
    throw new Error(
      `Expected content[${index}] to be type "text", got "${item.type}"`,
    )
  }
  return item as TextContent
}

describe('SearchDataTablesTool', () => {
  let tool: SearchDataTablesTool
  let mockDbService: {
    healthCheck: Mock
    query: Mock
  }

  beforeAll(() => {
    mockDbService = {
      healthCheck: vi.fn(),
      query: vi.fn(),
    }
    ;(DatabaseService.getInstance as Mock).mockReturnValue(mockDbService)
  })

  beforeEach(() => {
    mockDbService.healthCheck.mockReset().mockResolvedValue(true)
    mockDbService.query.mockReset().mockResolvedValue({ rows: mockDataTables })

    tool = new SearchDataTablesTool()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should have the correct metadata', () => {
    validateToolStructure(tool)
    expect(tool.name).toBe('search-data-tables')
    expect(tool.description).toBe(toolDescription)
    expect(tool.requiresApiKey).toBe(false)
  })

  it('should have valid input schema', () => {
    const schema = tool.inputSchema

    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('data_table_id')
    expect(schema.properties).toHaveProperty('label_query')
    expect(schema.properties).toHaveProperty('api_endpoint')
    expect(schema.properties).toHaveProperty('limit')
    expect(schema.required).toEqual([])
  })

  describe('args schema validation', () => {
    it('should accept data_table_id alone', () => {
      expect(() => tool.argsSchema.parse(byIdArgs)).not.toThrow()
    })

    it('should accept label_query alone', () => {
      expect(() => tool.argsSchema.parse(byLabelArgs)).not.toThrow()
    })

    it('should accept api_endpoint alone', () => {
      expect(() => tool.argsSchema.parse(byApiEndpointArgs)).not.toThrow()
    })

    it('should accept all params together', () => {
      expect(() => tool.argsSchema.parse(allParamsArgs)).not.toThrow()
    })

    it('should reject when no search params are provided', () => {
      expect(() => tool.argsSchema.parse({})).toThrow(
        'At least one search parameter must be provided: data_table_id, label_query, or api_endpoint.',
      )
    })

    it('should reject limit above 100', () => {
      expect(() =>
        tool.argsSchema.parse({ data_table_id: 'B16005', limit: 101 }),
      ).toThrow()
    })

    it('should reject a non-positive limit', () => {
      expect(() =>
        tool.argsSchema.parse({ data_table_id: 'B16005', limit: 0 }),
      ).toThrow()
    })
  })

  describe('Database Integration', () => {
    it('should check database health before querying', async () => {
      await tool.handler(byIdArgs)

      expect(mockDbService.healthCheck).toHaveBeenCalledOnce()
    })

    it('should return error when database is unhealthy', async () => {
      mockDbService.healthCheck.mockResolvedValue(false)

      const response = await tool.handler(byIdArgs)
      validateResponseStructure(response)
      expect(getTextContent(response).text).toContain(
        'Database connection failed',
      )
      expect(getTextContent(response).text).toContain('cannot search data tables')
    })

    it('should handle database query errors gracefully', async () => {
      mockDbService.query.mockRejectedValue(new Error('Connection timeout'))

      const response = await tool.handler(byIdArgs)
      validateResponseStructure(response)
      expect(getTextContent(response).text).toContain(
        'Failed to search data tables: Connection timeout',
      )
    })

    it('should call search_data_tables with correct positional params', async () => {
      await tool.handler(allParamsArgs)

      const [sql, params] = mockDbService.query.mock.calls[0]
      expect(sql).toContain('SELECT * FROM search_data_tables($1, $2, $3, $4)')
      expect(params).toEqual([
        'B16005',
        'language spoken at home',
        'acs/acs1',
        10,
      ])
    })

    it('should pass null for omitted optional params', async () => {
      await tool.handler(byLabelArgs)

      const [, params] = mockDbService.query.mock.calls[0]
      expect(params[0]).toBeNull() // data_table_id
      expect(params[1]).toBe('language spoken at home')
      expect(params[2]).toBeNull() // api_endpoint
      expect(params[3]).toBe(20) // default limit
    })

    it('should use default limit of 20 when limit is not provided', async () => {
      await tool.handler(byIdArgs)

      const [, params] = mockDbService.query.mock.calls[0]
      expect(params[3]).toBe(20)
    })
  })

  describe('Response Handling', () => {
    describe('when results are found', () => {
      it('renders matching data tables as numbered Record blocks', async () => {
        const result = await tool.handler(byLabelArgs)

        expect(result.content).toHaveLength(1)
        expect(result.content[0].type).toBe('text')
        const text = getTextContent(result).text
        expect(text).toContain('## Records')
        expect(text).toContain('Record 1:')
        expect(text).toContain('Record 2:')
        expect(text).toContain('data_table_id: B16005')
        expect(text).toContain('data_table_id: B16005D')
      })

      it('shows the component and datasets per record', async () => {
        const result = await tool.handler(byIdArgs)
        const text = getTextContent(result).text
        expect(text).toContain(
          'component: American Community Survey - ACS 1-Year Estimates',
        )
        expect(text).toMatch(/datasets: 2009: acs\/acs1; 2010: acs\/acs1/)
      })

      it('emits a ## Caveats TRUNCATED notice when results equal the limit', async () => {
        // Fixture has 2 rows; force limit=2 to trigger truncation.
        const result = await tool.handler({
          data_table_id: 'B16005',
          limit: 2,
        })
        const text = getTextContent(result).text
        expect(text).toContain('## Caveats')
        expect(text).toContain('**TRUNCATED:**')
        expect(text).toMatch(/\(Reminder:.*limited to 2.*\)/)
      })

      it('emits ASCII only', () => {
        // sanity: no smart quotes or em-dashes in the tool description either.
        for (const ch of tool.description) {
          expect(ch.charCodeAt(0)).toBeLessThanOrEqual(127)
        }
      })
    })

    describe('when no results are found', () => {
      beforeEach(() => {
        mockDbService.query.mockResolvedValue({ rows: [] })
      })

      it('returns an actionable no-results message for a data_table_id search', async () => {
        const result = await tool.handler({ data_table_id: 'ZZZZZZ' })
        const text = getTextContent(result).text
        expect(text).toContain('## Result')
        expect(text).toContain('No data tables matched')
        expect(text).toContain('data_table_id "ZZZZZZ"')
        // Should suggest a recovery path without prescribing a magic string.
        expect(text).toMatch(/Retry/)
      })

      it('lists all provided search terms in the no-results message', async () => {
        const result = await tool.handler({
          data_table_id: 'B99999',
          label_query: 'obscure topic',
          api_endpoint: 'unknown/endpoint',
        })
        const text = getTextContent(result).text
        expect(text).toContain('data_table_id "B99999"')
        expect(text).toContain('label_query "obscure topic"')
        expect(text).toContain('api_endpoint "unknown/endpoint"')
      })
    })
  })
})
