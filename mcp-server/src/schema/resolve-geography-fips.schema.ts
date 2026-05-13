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

export type ResolveGeographyFipsArgs = z.infer<
  typeof ResolveGeographyFipsInputSchema
>
