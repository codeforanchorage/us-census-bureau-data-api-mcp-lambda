import { z } from 'zod'

export const FetchDatasetGeographyInputSchema = z.object({
  dataset: z.string().describe("Dataset identifier (e.g., 'acs/acs1')"),
  year: z
    .number()
    .describe('The year or vintage of the data, e.g. 1987')
    .optional(),
})

export const FetchDatasetGeographyArgsSchema = {
  type: 'object',
  properties: {
    dataset: {
      type: 'string',
      description: "The dataset identifier (e.g., 'acs/acs1')",
    },
    year: {
      type: 'number',
      description: 'The year of the data',
    },
  },
  required: ['dataset'],
}

// Schema for individual geography object in the fips array
export const GeographyFipsEntrySchema = z.object({
  name: z
    .string()
    .describe(
      "Geography name (e.g., 'state', 'county', 'congressional district')",
    ),
  geoLevelDisplay: z
    .string()
    .describe("3-digit geography code (e.g., '040', '050', '500')"),
  referenceDate: z.string().describe("Reference date (e.g., '2022-01-01')"),
  requires: z
    .array(z.string())
    .optional()
    .describe('Required parent geographies for this level'),
  wildcard: z
    .array(z.string())
    .optional()
    .describe('Geographies that can use wildcards'),
  optionalWithWCFor: z
    .string()
    .optional()
    .describe('Optional wildcard geography'),
})

// Schema for the actual Census geography.json API response
export const GeographyJsonSchema = z.object({
  fips: z
    .array(GeographyFipsEntrySchema)
    .describe('Array of available geography levels'),
})

// Parsed geography entry with structured fields
export const ParsedGeographyEntrySchema = z.object({
  vintage: z.string().describe('Reference date for this geography level'),
  displayName: z
    .string()
    .describe(
      "Human-readable display name (e.g., 'State', 'Congressional District')",
    ),
  querySyntax: z
    .string()
    .describe(
      "Exact syntax for API queries (e.g., 'state', 'congressional+district')",
    ),
  code: z.string().describe('3-digit geography level code'),
  name: z.string().describe('Technical name from API response'),
  hierarchy: z.array(z.string()).describe('Array of hierarchy levels'),
  fullName: z.string().describe('Complete geography name'),
  description: z
    .string()
    .optional()
    .describe('Additional description if provided'),
  onSpine: z
    .boolean()
    .describe('Whether this geography is on the census geography spine'),
  queryExample: z.string().describe('Example API query syntax'),
  requires: z
    .array(z.string())
    .optional()
    .describe('Required parent geographies'),
  allowsWildcard: z
    .array(z.string())
    .optional()
    .describe('Geographies that support wildcards'),
  wildcardFor: z
    .string()
    .optional()
    .describe('Geography this can be wildcarded for'),
})

// Parsed geography.json response with structured data
export const ParsedGeographyJsonSchema = z.array(ParsedGeographyEntrySchema)

// Parse Geography Function
export function parseGeographyJson(
  rawGeography: unknown,
): z.infer<typeof ParsedGeographyJsonSchema> {
  const validatedRaw = GeographyJsonSchema.parse(rawGeography)

  if (validatedRaw.fips.length === 0) {
    console.log('No FIPS geography data found in response')
    return []
  }

  // Basic parsing without metadata - the tool will enhance this with database data
  const parsed = validatedRaw.fips.map((entry) => {
    return {
      vintage: entry.referenceDate,
      displayName: entry.name,
      querySyntax: entry.name.replace(/\s+/g, '+'), // Replaces all whitespaces with '+'
      code: entry.geoLevelDisplay,
      name: entry.name,
      hierarchy: entry.requires
        ? [...entry.requires, entry.name]
        : [entry.name],
      fullName: entry.name,
      description: undefined,
      onSpine: false,
      queryExample: `for=${entry.name.replace(/\s+/g, '+')}:*`, // Replaces all whitespaces with '+'
      requires: entry.requires,
      allowsWildcard: entry.wildcard,
      wildcardFor: entry.optionalWithWCFor,
    }
  })

  return ParsedGeographyJsonSchema.parse(parsed)
}

// Schema for structuredContent (emitted as outputSchema in tools/list).
// Mirrors what parseGeographyJsonWithDb actually emits -- note
// allowsWildcard is a BOOLEAN there (unlike ParsedGeographyEntrySchema,
// which describes the unused base parser's shape).
export const FetchDatasetGeographyOutputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'object',
      properties: {
        dataset: { type: 'string' },
        year: {
          type: ['number', 'null'],
          description: 'null when the dataset is not vintage-scoped.',
        },
      },
      required: ['dataset', 'year'],
    },
    total_count: {
      type: 'integer',
      description:
        'Number of geography levels this dataset publishes. 0 means the dataset exposes no FIPS geography levels.',
    },
    levels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          vintage: { type: 'string' },
          displayName: { type: 'string' },
          querySyntax: {
            type: 'string',
            description:
              "Exact for=/in= level syntax (e.g. 'congressional+district').",
          },
          code: {
            type: 'string',
            description:
              '3-digit summary level code as a string; leading zeros are significant.',
          },
          name: { type: 'string' },
          hierarchy: { type: 'array', items: { type: 'string' } },
          fullName: { type: 'string' },
          description: { type: 'string' },
          onSpine: { type: 'boolean' },
          queryExample: { type: 'string' },
          requires: { type: 'array', items: { type: 'string' } },
          allowsWildcard: { type: 'boolean' },
          wildcardFor: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'vintage',
          'displayName',
          'querySyntax',
          'code',
          'name',
          'hierarchy',
          'fullName',
          'onSpine',
          'queryExample',
          'allowsWildcard',
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
  required: ['query', 'total_count', 'levels', 'caveats'],
}

export type FetchDatasetGeographyArgs = z.infer<
  typeof FetchDatasetGeographyInputSchema
>
export type GeographyFipsEntry = z.infer<typeof GeographyFipsEntrySchema>
export type GeographyJson = z.infer<typeof GeographyJsonSchema>
export type ParsedGeographyEntry = z.infer<typeof ParsedGeographyEntrySchema>
export type ParsedGeographyJson = z.infer<typeof ParsedGeographyJsonSchema>
