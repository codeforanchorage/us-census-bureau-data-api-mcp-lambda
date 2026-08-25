import { z } from 'zod'

export const SearchDataTablesArgsSchema = {
  type: 'object',
  properties: {
    data_table_id: {
      type: 'string',
      description:
        'Census table ID or prefix to search by (e.g., "B16005" matches B16005, B16005A, B16005D, etc.). Supports exact match or prefix match.',
    },
    label_query: {
      type: 'string',
      description:
        'Natural language search phrase for the table label (e.g., "language spoken at home", "income by age"). Uses fuzzy similarity matching against Census label vocabulary -- results are sensitive to phrasing. Prefer Census terminology over plain language when possible (e.g., "poverty" over "low income", "tenure" over "renting vs owning"). Imprecise or paraphrased queries may return poor or irrelevant matches.',
    },
    api_endpoint: {
      type: 'string',
      description:
        'Scope results to a specific data API endpoint (e.g., "acs/acs1"). Strongly recommended when the survey or dataset is already known -- dramatically reduces noise and improves result quality. Use the datasets field from a prior search result, or the api_endpoint field from list-datasets, to identify valid values.',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of results to return. Defaults to 20.',
    },
  },
  required: [],
} as const

export const SearchDataTablesInputSchema = z
  .object({
    data_table_id: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Census table ID or prefix to search by (e.g., "B16005" matches B16005, B16005A, B16005D, etc.). Supports exact match or prefix match.',
      ),
    label_query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Natural language search phrase for the table label (e.g., "language spoken at home", "income by age"). Uses fuzzy similarity matching.',
      ),
    api_endpoint: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Scope results to a specific component API endpoint (e.g., "acs/acs1"). When provided, only tables available under that component are returned.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum number of results to return. Defaults to 20.'),
  })
  .refine(
    (args) =>
      args.data_table_id !== undefined ||
      args.label_query !== undefined ||
      args.api_endpoint !== undefined,
    {
      message:
        'At least one search parameter must be provided: data_table_id, label_query, or api_endpoint.',
    },
  )

// Schema for structuredContent (emitted as outputSchema in tools/list).
export const SearchDataTablesOutputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'object',
      description: 'Echo of the search as executed.',
      properties: {
        data_table_id: { type: ['string', 'null'] },
        label_query: { type: ['string', 'null'] },
        api_endpoint: { type: ['string', 'null'] },
        limit: { type: 'integer' },
      },
      required: ['data_table_id', 'label_query', 'api_endpoint', 'limit'],
    },
    total_count: {
      type: ['integer', 'null'],
      description:
        'Total matching tables when known. null means unmeasured: the search returned exactly `limit` rows, so more may exist beyond them. 0 means the search ran and matched nothing.',
    },
    shown_count: {
      type: 'integer',
      description: 'Number of records included below.',
    },
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          data_table_id: { type: 'string' },
          label: { type: 'string' },
          component: { type: ['string', 'null'] },
          datasets: {
            type: 'array',
            description:
              'Dataset/vintage combinations the table appears in. Years are strings, not numbers.',
            items: {
              type: 'object',
              properties: {
                year: { type: 'string' },
                endpoints: { type: 'array', items: { type: 'string' } },
              },
              required: ['year', 'endpoints'],
            },
          },
        },
        required: ['data_table_id', 'label', 'component', 'datasets'],
      },
    },
    caveats: {
      type: 'array',
      description:
        'Machine-readable qualifications; every message also appears in the text content.',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['code', 'message'],
      },
    },
  },
  required: ['query', 'total_count', 'shown_count', 'records', 'caveats'],
}

export type SearchDataTablesArgs = z.infer<typeof SearchDataTablesInputSchema>
