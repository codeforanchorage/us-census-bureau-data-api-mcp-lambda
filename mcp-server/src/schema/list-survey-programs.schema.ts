import { z } from 'zod'

export const ListSurveyProgramsInputSchema = z.object({})
export type ListSurveyProgramsArgs = z.infer<
  typeof ListSurveyProgramsInputSchema
>

export const ListSurveyProgramsArgsSchema = {
  type: 'object',
  properties: {},
  required: [],
}

// Schema for structuredContent (emitted as outputSchema in tools/list).
export const ListSurveyProgramsOutputSchema = {
  type: 'object',
  properties: {
    total_count: {
      type: 'integer',
      description: 'Number of survey programs.',
    },
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          program_label: { type: 'string' },
          program_string: {
            type: 'string',
            description:
              'Program acronym to pass to list-survey-components (e.g. "ACS").',
          },
          description: { type: ['string', 'null'] },
          table_count: {
            type: 'integer',
            description:
              '0 means no tables are indexed in search-data-tables for this program -- NOT that the program has no data; fetch-aggregate-data with known variable names may still work.',
          },
        },
        required: [
          'program_label',
          'program_string',
          'description',
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
  required: ['total_count', 'records', 'caveats'],
}
