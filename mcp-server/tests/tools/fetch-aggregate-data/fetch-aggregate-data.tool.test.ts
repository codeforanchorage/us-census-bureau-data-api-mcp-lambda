const mockFetch = vi.fn()

vi.mock('node-fetch', () => ({
  default: mockFetch,
}))

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildCitation } from '../../../src/helpers/citation'
import { clearVariablesCache } from '../../../src/helpers/variables-cache'
import {
  FetchAggregateDataTool,
  toolDescription,
} from '../../../src/tools/fetch-aggregate-data.tool'
import {
  validateToolStructure,
  validateResponseStructure,
  createMockFetchError,
} from '../../helpers/test-utils'

import { sampleTableByGroupData } from '../../helpers/test-data'

vi.mock('../../../src/helpers/citation', () => ({
  buildCitation: vi.fn((url: string) => {
    return `Source: U.S. Census Bureau Data API (${url})`
  }),
}))

const VARIABLES_FIXTURE = {
  variables: {
    B01001_001E: {
      label: 'Estimate!!Total',
      concept: 'Sex By Age',
      group: 'B01001',
    },
    B01001_001M: {
      label: 'Margin of Error!!Total',
      group: 'B01001',
    },
    B25001_001E: {
      label: 'Estimate!!Total housing units',
      group: 'B25001',
    },
    B25001_001M: {
      label: 'Margin of Error!!Total housing units',
      group: 'B25001',
    },
    NAME: { label: 'Geographic Area Name', group: 'N/A' },
  },
}

// When the tool requests variables.json, return the fixture. Tests can stack
// additional mockResolvedValueOnce calls before this for the data call.
function mockDefaultVariablesFetch() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/variables.json')) {
      return Promise.resolve(
        new Response(JSON.stringify(VARIABLES_FIXTURE), { status: 200 }),
      )
    }
    return Promise.resolve(
      new Response(JSON.stringify(sampleTableByGroupData), { status: 200 }),
    )
  })
}

describe('FetchAggregateDataTool', () => {
  let tool: FetchAggregateDataTool

  beforeEach(() => {
    tool = new FetchAggregateDataTool()
    mockFetch.mockClear()
    clearVariablesCache()

    process.env.CENSUS_API_KEY = 'test-api-key-12345'
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    clearVariablesCache()
  })

  describe('toolHandler', () => {
    it('invokes buildCitation', async () => {
      const mockBuildCitation = buildCitation as ReturnType<typeof vi.fn>
      mockDefaultVariablesFetch()

      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: {
          group: 'B01001',
        },
        for: 'state:01',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)

      expect(mockBuildCitation).toHaveBeenCalled()
      expect(response.content[0].text).to.include(
        'Source: U.S. Census Bureau Data API',
      )
    })
  })

  describe('Tool Configuration', () => {
    it('should have correct tool metadata', () => {
      validateToolStructure(tool)
      expect(tool.name).toBe('fetch-aggregate-data')
      expect(tool.description).toBe(toolDescription)
      expect(tool.requiresApiKey).toBe(true)
    })

    it('should have valid input schema', () => {
      const schema = tool.inputSchema
      expect(schema.type).toBe('object')
      expect(schema.properties).toHaveProperty('dataset')
      expect(schema.properties).toHaveProperty('year')
      expect(schema.properties).toHaveProperty('get')
      expect(schema.required).toEqual(['dataset', 'year', 'get'])
    })

    it('should validate presence of for or ucgid', () => {
      const missingGeoArg = {
        dataset: 'acs/acs1',
        year: 2022,
        get: {
          group: 'B01001',
        },
      }

      const result = tool.argsSchema.safeParse(missingGeoArg)

      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'custom',
            message:
              'No geography specified error - define for or ucgid arguments.',
          }),
        ]),
      )
    })

    it('should accept valid optional parameters', () => {
      const validArgs = {
        dataset: 'acs/acs1',
        year: 2022,
        get: {
          group: 'B01001',
          variables: ['PAYQTR1'],
        },
        for: 'state:01',
        in: 'us:1',
        predicates: { AGEGROUP: '29', PAYANN: '100000' },
        descriptive: true,
      }
      expect(() => tool.argsSchema.parse(validArgs)).not.toThrow()
    })

    it('should reject dataset if tool mismatch', () => {
      const invalidArgs = {
        dataset: 'timeseries/data/set',
        year: 2022,
        get: { group: 'B01001' },
        for: 'state:*',
      }
      const result = tool.validateArgs(invalidArgs)
      expect(result.error.issues[0].message).toContain(
        'This data is currently not supported by the U.S. Census Bureau Data API MCP Server.',
      )
    })
  })

  describe('URL Construction', () => {
    beforeEach(() => {
      mockDefaultVariablesFetch()
    })

    it('should construct basic URL correctly', async () => {
      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: { group: 'B01001' },
        for: 'state:*',
      }

      await tool.toolHandler(args, process.env.CENSUS_API_KEY)

      const dataCalls = mockFetch.mock.calls.filter(
        (c) => !String(c[0]).includes('/variables.json'),
      )
      expect(dataCalls[0][0]).toContain(
        'https://api.census.gov/data/2022/acs/acs1',
      )
      expect(dataCalls[0][0]).toContain('get=group%28B01001%29')
    })

    it('should include optional parameters in URL', async () => {
      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: { group: 'B01001' },
        for: 'state:01',
        in: 'us:1',
        predicates: { AGEGROUP: '29' },
        descriptive: true,
      }

      await tool.toolHandler(args, process.env.CENSUS_API_KEY)

      const dataCall = mockFetch.mock.calls.find(
        (c) => !String(c[0]).includes('/variables.json'),
      )!
      const calledUrl = dataCall[0]
      expect(calledUrl).toContain('for=state%3A01')
      expect(calledUrl).toContain('in=us%3A1')
      expect(calledUrl).toContain('AGEGROUP=29')
      expect(calledUrl).toContain('descriptive=true')
    })
  })

  describe('Response formatting', () => {
    it('renders provenance banner + retrieved timestamp + citation', async () => {
      mockDefaultVariablesFetch()

      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: { group: 'B01001' },
        for: 'state:*',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      validateResponseStructure(response)

      const text = response.content[0].text as string
      expect(text).toContain('## Source')
      expect(text).toContain('ACS 1-Year Estimates, 2022')
      expect(text).toContain('## Provenance')
      expect(text).toMatch(/Retrieved: \d{4}-\d{2}-\d{2}T/)
      expect(text).toContain('Source: U.S. Census Bureau Data API')
    })

    it('auto-pairs the MOE companion and announces it in the body', async () => {
      // Mock data response that includes both _E and _M so the formatter has
      // the data to pair.
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(
            new Response(JSON.stringify(VARIABLES_FIXTURE), { status: 200 }),
          )
        }
        const data = [
          ['NAME', 'B25001_001E', 'B25001_001M', 'state'],
          ['Alaska', '300000', '1500', '02'],
        ]
        return Promise.resolve(
          new Response(JSON.stringify(data), { status: 200 }),
        )
      })

      const args = {
        dataset: 'acs/acs5',
        year: 2022,
        get: { variables: ['NAME', 'B25001_001E'] },
        for: 'state:02',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string

      const dataCall = mockFetch.mock.calls.find(
        (c) => !String(c[0]).includes('/variables.json'),
      )!
      // The MOE companion should have been added to the get= URL automatically.
      expect(decodeURIComponent(dataCall[0])).toContain('B25001_001M')
      expect(text).toContain('**MOE AUTO-PAIRED:**')
      expect(text).toContain('300,000')
      expect(text).toContain('1,500')
      expect(text).toContain('+/-')
      expect(text).toContain('(90% CI)')
    })

    it('decodes suppression sentinels rather than passing them through', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(
            new Response(JSON.stringify(VARIABLES_FIXTURE), { status: 200 }),
          )
        }
        const data = [
          ['NAME', 'B25001_001E', 'B25001_001M', 'state'],
          ['Suppressed Place', '-666666666', '-666666666', '02'],
        ]
        return Promise.resolve(
          new Response(JSON.stringify(data), { status: 200 }),
        )
      })

      const args = {
        dataset: 'acs/acs5',
        year: 2022,
        get: { variables: ['NAME', 'B25001_001E'] },
        for: 'state:02',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string
      expect(text).toContain('NOT_APPLICABLE')
      expect(text).not.toMatch(/-666666666/)
    })

    it('accepts NAME and pairs the MOE when both exist only as attributes (live acs5-2023 shape)', async () => {
      // The real acs/acs5 2023 catalog omits NAME and the _M companions as
      // top-level variables; they only appear in `attributes`. Regression
      // test for the live bug where NAME was rejected as an unknown code.
      const liveShapeFixture = {
        variables: {
          GEO_ID: { label: 'Geography', group: 'N/A', attributes: 'NAME' },
          B01003_001E: {
            label: 'Estimate!!Total',
            group: 'B01003',
            attributes: 'B01003_001EA,B01003_001M,B01003_001MA',
          },
        },
      }
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(
            new Response(JSON.stringify(liveShapeFixture), { status: 200 }),
          )
        }
        const data = [
          ['NAME', 'B01003_001E', 'B01003_001M', 'state'],
          ['Alaska', '733406', '0', '02'],
        ]
        return Promise.resolve(
          new Response(JSON.stringify(data), { status: 200 }),
        )
      })

      const args = {
        dataset: 'acs/acs5',
        year: 2023,
        get: { variables: ['NAME', 'B01003_001E'] },
        for: 'state:02',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string
      expect(text).not.toContain('Unknown cell code')

      const dataCall = mockFetch.mock.calls.find(
        (c) => !String(c[0]).includes('/variables.json'),
      )!
      expect(decodeURIComponent(dataCall[0])).toContain('B01003_001M')
      expect(text).toContain('**MOE AUTO-PAIRED:**')
    })

    it('rejects unknown group codes with a "did you mean" hint', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(
            new Response(JSON.stringify(VARIABLES_FIXTURE), { status: 200 }),
          )
        }
        // Should never be called -- validation should intercept.
        return Promise.resolve(new Response('[]', { status: 200 }))
      })

      const args = {
        dataset: 'acs/acs5',
        year: 2022,
        get: { group: 'B01002' },
        for: 'state:02',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string
      expect(text).toContain('Unknown group code')
      expect(text).toContain('did you mean')
      expect(text).toContain('B01001')
      expect(text).toContain('search-data-tables')

      // Confirm we didn't actually hit the data endpoint.
      const dataCalls = mockFetch.mock.calls.filter(
        (c) => !String(c[0]).includes('/variables.json'),
      )
      expect(dataCalls.length).toBe(0)
    })

    it('rejects unknown cell codes with a "did you mean" hint', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(
            new Response(JSON.stringify(VARIABLES_FIXTURE), { status: 200 }),
          )
        }
        // Should never be called -- validation should intercept.
        return Promise.resolve(new Response('[]', { status: 200 }))
      })

      const args = {
        dataset: 'acs/acs5',
        year: 2022,
        get: { variables: ['B25001_999E'] },
        for: 'state:02',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string
      expect(text).toContain('Unknown cell code')
      expect(text).toContain('did you mean')
      expect(text).toContain('B25001_001E')

      // Confirm we didn't actually hit the data endpoint.
      const dataCalls = mockFetch.mock.calls.filter(
        (c) => !String(c[0]).includes('/variables.json'),
      )
      expect(dataCalls.length).toBe(0)
    })
  })

  describe('API Response Handling', () => {
    it('should handle successful API response', async () => {
      mockDefaultVariablesFetch()

      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: { group: 'B01001' },
        for: 'state:*',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      validateResponseStructure(response)

      const responseText = response.content[0].text
      expect(responseText).toContain('Alabama')
      expect(responseText).toContain('Alaska')
      expect(responseText).toContain('Arizona')
    })

    it('produces an actionable 404 message that points the model back to list-datasets', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(new Response('nope', { status: 404 }))
        }
        return Promise.resolve(
          new Response('not found', { status: 404, statusText: 'Not Found' }),
        )
      })

      const args = {
        dataset: 'acs/acs1',
        year: 9999,
        get: { group: 'B01001' },
        for: 'state:*',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string
      expect(text).toContain('404')
      expect(text).toContain('list-datasets')
    })

    it('explains the ACS 1-year 65,000 population threshold on a 400 and suggests acs/acs5', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(new Response('nope', { status: 404 }))
        }
        return Promise.resolve(
          new Response('bad request', {
            status: 400,
            statusText: 'Bad Request',
          }),
        )
      })

      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: { group: 'B01001' },
        for: 'place:00100',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string
      expect(text).toContain('65,000')
      expect(text).toContain('acs/acs5')
    })

    it('explains a 204 No Content as "matched no data" rather than a JSON parse failure', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(
            new Response(JSON.stringify(VARIABLES_FIXTURE), { status: 200 }),
          )
        }
        return Promise.resolve(new Response(null, { status: 204 }))
      })

      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: { group: 'B01001' },
        for: 'state:01',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string
      expect(text).toContain('no data')
      expect(text).toContain('resolve-geography-fips')
      expect(text).not.toContain('Fetch failed')
    })

    it('treats a 200 with an empty body the same as a 204', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(
            new Response(JSON.stringify(VARIABLES_FIXTURE), { status: 200 }),
          )
        }
        return Promise.resolve(new Response('', { status: 200 }))
      })

      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: { group: 'B01001' },
        for: 'state:01',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string
      expect(text).toContain('no data')
      expect(text).not.toContain('Fetch failed')
    })

    it('reports a non-JSON body as a Census API problem, not a crash', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return Promise.resolve(
            new Response(JSON.stringify(VARIABLES_FIXTURE), { status: 200 }),
          )
        }
        return Promise.resolve(
          new Response('<html>Service Unavailable</html>', { status: 200 }),
        )
      })

      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: { group: 'B01001' },
        for: 'state:01',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      const text = response.content[0].text as string
      expect(text).toContain('non-JSON')
    })

    it('should handle network errors', async () => {
      // Variables fetch fails silently; data fetch rejects.
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/variables.json')) {
          return createMockFetchError('vars network error')
        }
        return createMockFetchError('Network error')
      })

      const args = {
        dataset: 'acs/acs1',
        year: 2022,
        get: { group: 'B01001' },
        for: 'state:*',
      }

      const response = await tool.toolHandler(args, process.env.CENSUS_API_KEY)
      validateResponseStructure(response)
      expect(response.content[0].text).toContain('Fetch failed: Network error')
    })
  })
})
