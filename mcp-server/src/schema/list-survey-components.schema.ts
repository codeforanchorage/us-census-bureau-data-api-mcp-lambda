import { z } from 'zod'

const PROGRAM_STRING_HINT =
  'Program acronym from list-survey-programs, e.g. "ACS", "DEC", "CPS". Case-insensitive; matched exactly after uppercasing.'

export const ListSurveyComponentsInputSchema = z.object({
  program_string: z.string().trim().min(1).describe(PROGRAM_STRING_HINT),
})
export type ListSurveyComponentsArgs = z.infer<
  typeof ListSurveyComponentsInputSchema
>

export const ListSurveyComponentsArgsSchema = {
  type: 'object',
  properties: {
    program_string: {
      type: 'string',
      description: PROGRAM_STRING_HINT,
      examples: ['ACS', 'DEC', 'CPS'],
    },
  },
  required: ['program_string'],
}

// Schema for structuredContent (emitted as outputSchema in tools/list).
export const ListSurveyComponentsOutputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'object',
      properties: {
        program_string: {
          type: 'string',
          description: 'The acronym as matched (uppercased).',
        },
      },
      required: ['program_string'],
    },
    total_count: {
      type: 'integer',
      description:
        'Number of components in this program. 0 means the acronym matched no program (see the NO_MATCH caveat), not that the Census lacks the survey.',
    },
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component_label: { type: 'string' },
          component_string: { type: 'string' },
          api_endpoint: {
            type: 'string',
            description:
              "Pass this as api_endpoint to search-data-tables and as dataset to fetch-aggregate-data / fetch-dataset-geography (e.g. 'acs/acs5').",
          },
          frequency: { type: ['string', 'null'] },
          frequency_notes: { type: ['string', 'null'] },
          vintage_start: {
            type: ['integer', 'null'],
            description: 'Earliest published vintage; null when no datasets are linked.',
          },
          vintage_end: {
            type: ['integer', 'null'],
            description: 'Latest published vintage; null when no datasets are linked.',
          },
          has_gaps: {
            type: ['boolean', 'null'],
            description:
              'true when the vintage range has missing years (verify a specific year via list-datasets before querying it); null when no datasets are linked.',
          },
          table_count: {
            type: 'integer',
            description:
              '0 means no tables are indexed in search-data-tables for this component -- NOT that the component has no data.',
          },
          description: { type: ['string', 'null'] },
        },
        required: [
          'component_label',
          'component_string',
          'api_endpoint',
          'frequency',
          'vintage_start',
          'vintage_end',
          'has_gaps',
          'table_count',
        ],
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
  required: ['query', 'total_count', 'records', 'caveats'],
}
