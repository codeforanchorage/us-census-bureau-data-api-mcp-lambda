import { z } from 'zod'

const SUMMARY_LEVEL_HINT =
  'Optional filter for the geography summary level. Accepts either a name ("State", "County", "Place", "Census Tract", "Block Group", "County Subdivision", "ZIP Code Tabulation Area", "Congressional District") or a 3-digit code ("040", "050", "160", "140", "150"). Resolution uses fuzzy match -- pass the most common form first.'

export const ResolveGeographyFipsInputSchema = z.object({
  geography_name: z
    .string()
    .min(1)
    .describe('The geography to resolve, e.g. "Philadelphia, Pennsylvania", "Cook County", "Alaska".'),
  summary_level: z.string().min(1).optional().describe(SUMMARY_LEVEL_HINT),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Maximum number of matching geographies to return. Defaults to 25.'),
})

export const ResolveGeographyFipsArgsSchema = {
  type: 'object',
  properties: {
    geography_name: {
      type: 'string',
      description:
        'The geography to resolve, e.g. "Philadelphia, Pennsylvania", "Cook County", "Alaska".',
      examples: [
        'Philadelphia city, Pennsylvania',
        'Philadelphia County, Pennsylvania',
        'Philadelphia, Pennsylvania',
        'Philadelphia',
      ],
    },
    summary_level: {
      type: 'string',
      description: SUMMARY_LEVEL_HINT,
      examples: ['State', 'County', 'Place', 'Census Tract', '040', '050', '160'],
    },
    limit: {
      type: 'number',
      description: 'Maximum number of matching geographies to return. Defaults to 25.',
    },
  },
  required: ['geography_name'],
}

// Schema for structuredContent (emitted as outputSchema in tools/list).
// Binding: never declare a constraint real data can violate. FIPS pieces
// inside for/in stay strings end to end -- leading zeros are load-bearing.
export const ResolveGeographyFipsOutputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'object',
      description: 'Echo of the search as executed.',
      properties: {
        geography_name: { type: 'string' },
        summary_level_requested: {
          type: ['string', 'null'],
          description: 'The summary_level argument as passed, or null.',
        },
        summary_level_resolved: {
          type: ['string', 'null'],
          description:
            'The summary level the filter actually resolved to; null when none was requested or the requested one matched nothing (see the SUMMARY_LEVEL_IGNORED caveat).',
        },
      },
      required: [
        'geography_name',
        'summary_level_requested',
        'summary_level_resolved',
      ],
    },
    total_count: {
      type: 'integer',
      description:
        'Total geographies matched. 0 means the search ran and matched nothing.',
    },
    shown_count: {
      type: 'integer',
      description: 'Number of records included below (after the limit).',
    },
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary_level: { type: 'string' },
          for: {
            type: 'string',
            description:
              'Ready-to-use for= query string for fetch-aggregate-data. FIPS codes are strings; leading zeros are significant.',
          },
          in: {
            type: ['string', 'null'],
            description:
              'Parent-geography in= query string, or null for levels with no required parent.',
          },
          latitude: { type: ['number', 'null'] },
          longitude: { type: ['number', 'null'] },
        },
        required: ['name', 'summary_level', 'for', 'in'],
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

export type ResolveGeographyFipsArgs = z.infer<
  typeof ResolveGeographyFipsInputSchema
>
