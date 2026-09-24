import { z } from 'zod'

export const ComparePlacesArgsSchema = z.object({
  topic: z
    .string()
    .trim()
    .min(1)
    .describe(
      'What to compare, e.g. "median household income" or "poverty rate"',
    ),
  places: z
    .string()
    .trim()
    .min(1)
    .describe(
      'The places to compare, comma-separated, e.g. "Anchorage, Fairbanks, Juneau"',
    ),
})
