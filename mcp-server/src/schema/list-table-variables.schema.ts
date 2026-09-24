import { z } from 'zod'

const DATASET_HINT =
  "Dataset identifier, e.g. 'acs/acs5' or 'dec/dhc' (an api_endpoint from list-survey-components, or a dataset from list-datasets)."
const YEAR_HINT = 'Vintage year of the dataset, e.g. 2023.'
const TABLE_ID_HINT =
  "Table ID from search-data-tables, e.g. 'B19013' or 'S1701'. Case-insensitive."
const LABEL_FILTER_HINT =
  "Optional case-insensitive substring to narrow the variables by label, e.g. 'female' or 'under 5'."
const LIMIT_HINT = 'Maximum variables to return (default 100, max 500).'

export const ListTableVariablesInputSchema = z.object({
  dataset: z.string().trim().min(1).describe(DATASET_HINT),
  year: z.number().int().describe(YEAR_HINT),
  table_id: z.string().trim().min(1).describe(TABLE_ID_HINT),
  label_filter: z.string().trim().min(1).optional().describe(LABEL_FILTER_HINT),
  limit: z.number().int().min(1).max(500).optional().describe(LIMIT_HINT),
})
export type ListTableVariablesArgs = z.infer<
  typeof ListTableVariablesInputSchema
>

export const ListTableVariablesArgsSchema = {
  type: 'object',
  properties: {
    dataset: {
      type: 'string',
      description: DATASET_HINT,
      examples: ['acs/acs5', 'acs/acs1', 'dec/dhc'],
    },
    year: { type: 'integer', description: YEAR_HINT, examples: [2023] },
    table_id: {
      type: 'string',
      description: TABLE_ID_HINT,
      examples: ['B19013', 'B01001'],
    },
    label_filter: { type: 'string', description: LABEL_FILTER_HINT },
    limit: {
      type: 'integer',
      description: LIMIT_HINT,
      minimum: 1,
      maximum: 500,
    },
  },
  required: ['dataset', 'year', 'table_id'],
}

// Schema for structuredContent (emitted as outputSchema in tools/list).
export const ListTableVariablesOutputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'object',
      properties: {
        dataset: { type: 'string' },
        year: { type: 'integer' },
        table_id: {
          type: 'string',
          description: 'The table ID as matched (uppercased).',
        },
        label_filter: { type: ['string', 'null'] },
      },
      required: ['dataset', 'year', 'table_id', 'label_filter'],
    },
    concept: {
      type: ['string', 'null'],
      description: "The table's title as published in the Census catalog.",
    },
    table_variable_count: {
      type: 'integer',
      description:
        'Variables in the table before label_filter is applied. Margin-of-error and annotation companions are not counted.',
    },
    total_count: {
      type: 'integer',
      description:
        'Variables matching label_filter (all of them when there is no filter). 0 means the filter matched nothing, not that the table is empty.',
    },
    shown_count: { type: 'integer' },
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              "Cell code to pass in get.variables to fetch-aggregate-data (e.g. 'B19013_001E').",
          },
          label: { type: 'string' },
          has_moe: {
            type: 'boolean',
            description:
              'true when the variable has a published margin of error; fetch-aggregate-data pairs it automatically.',
          },
        },
        required: ['code', 'label', 'has_moe'],
      },
    },
    caveats: {
      type: 'array',
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
  required: [
    'query',
    'concept',
    'table_variable_count',
    'total_count',
    'shown_count',
    'records',
    'caveats',
  ],
}
