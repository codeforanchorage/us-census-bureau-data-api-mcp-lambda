import { z } from 'zod'

// Zod schema for the returned dataset
export const AggregatedResultSchema = z.object({
  dataset: z.string(),
  years: z.array(z.number()).optional(),
  title: z.string(),
})

// Schema for structuredContent (emitted as outputSchema in tools/list).
export const ListDatasetsOutputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'object',
      properties: {
        query: { type: ['string', 'null'] },
        dataset: { type: ['string', 'null'] },
      },
      required: ['query', 'dataset'],
    },
    catalog_count: {
      type: 'integer',
      description:
        'Number of aggregate datasets in the whole catalog, before any filter.',
    },
    total_count: {
      type: 'integer',
      description:
        'Number of datasets returned (after the query/dataset filters). 0 means the filter matched nothing, not that the Census lacks the data.',
    },
    datasets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          dataset: {
            type: 'string',
            description:
              "Dataset identifier to pass to the other tools (e.g. 'acs/acs5').",
          },
          title: { type: 'string' },
          years: {
            type: 'array',
            items: { type: 'number' },
            description:
              'Published vintages, ascending. May be empty for datasets without a vintage axis.',
          },
        },
        required: ['dataset', 'title'],
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
  required: ['query', 'catalog_count', 'total_count', 'datasets', 'caveats'],
}

const QUERY_HINT =
  "Optional case-insensitive filter: every word must appear in the dataset ID or title, e.g. 'acs5 profile' or 'county business patterns'."
const DATASET_HINT =
  "Optional exact dataset ID, e.g. 'acs/acs5', to get just that dataset's title and published vintages."

export const ListDatasetsInputSchema = z.object({
  query: z.string().trim().min(1).optional().describe(QUERY_HINT),
  dataset: z.string().trim().min(1).optional().describe(DATASET_HINT),
})
export type ListDatasetsArgs = z.infer<typeof ListDatasetsInputSchema>

export const ListDatasetsArgsSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: QUERY_HINT,
      examples: ['acs5 profile', 'decennial'],
    },
    dataset: {
      type: 'string',
      description: DATASET_HINT,
      examples: ['acs/acs5', 'dec/dhc'],
    },
  },
  required: [],
}

// Zod schema for the simplified dataset
export const SimplifiedAPIDatasetSchema = z.object({
  c_dataset: z.string(),
  c_vintage: z.number().optional(),
  title: z.string(),
  c_isAggregate: z.boolean().optional(),
})

export const DatasetSchema = z.object({
  c_vintage: z.number().optional(),
  c_dataset: z.array(z.string()),
  c_geographyLink: z.string(),
  c_tags: z.string().nullable().optional(),
  c_variablesLink: z.string(),
  c_examplesLink: z.string().nullable().optional(),
  c_groupsLink: z.string().nullable().optional(),
  c_sorts_url: z.string().nullable().optional(),
  c_documentationLink: z.string().nullable().optional(),
  c_isMicrodata: z.boolean().optional(),
  c_isTimeseries: z.boolean().optional(),
  c_isAggregate: z.boolean().optional(),
  c_isCube: z.boolean().optional(),
  c_isAvailable: z.boolean(),
  '@type': z.string(),
  title: z.string(),
  accessLevel: z.string(),
  bureauCode: z.array(z.string()),
  description: z.string(),
  distribution: z.array(
    z.object({
      '@type': z.string(),
      accessURL: z.string(),
      description: z.string(),
      format: z.string(),
      mediaType: z.string(),
      title: z.string(),
    }),
  ),
  contactPoint: z.object({
    fn: z.string(),
    hasEmail: z.string(),
  }),
  identifier: z.string(),
  keyword: z.array(z.string()),
  license: z.string(),
  modified: z.string(),
  programCode: z.array(z.string()),
  references: z.array(z.string()),
  spatial: z.string().optional(),
  temporal: z.string().optional(),
  publisher: z.object({
    '@type': z.string(),
    name: z.string(),
    subOrganizationOf: z
      .object({
        '@type': z.string(),
        name: z.string(),
      })
      .optional(),
  }),
})

// Zod schema for the raw data from API
export const AllDatasetMetadataJsonSchema = z.object({
  '@context': z.string(),
  '@id': z.string(),
  '@type': z.string(),
  conformsTo: z.string(),
  describedBy: z.string(),
  dataset: z.array(DatasetSchema),
})

// Infer TypeScript types from Zod schemas
export type AggregatedResultType = z.infer<typeof AggregatedResultSchema>
export type SimplifiedAPIDatasetType = z.infer<
  typeof SimplifiedAPIDatasetSchema
>
export type DatasetType = z.infer<typeof DatasetSchema>
export type AllDatasetMetadataJsonResponseType = z.infer<
  typeof AllDatasetMetadataJsonSchema
>
