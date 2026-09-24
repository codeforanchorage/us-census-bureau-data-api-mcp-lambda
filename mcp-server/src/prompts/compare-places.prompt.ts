import { z } from 'zod'
import { BasePrompt } from './base.prompt.js'
import { ComparePlacesArgsSchema } from '../schema/compare-places.prompt.schema.js'

// Walks the model through the full discovery chain for the most common
// multi-place question, including the step most often skipped: judging
// whether ACS differences are real given their margins of error.
export class ComparePlacesPrompt extends BasePrompt<
  z.infer<typeof ComparePlacesArgsSchema>
> {
  name = 'compare_places'
  title = 'Compare Places'
  description =
    'Compare a Census statistic (income, poverty, housing, ...) across several US places, with margins of error'

  arguments = [
    {
      name: 'topic',
      description:
        'What to compare, e.g. "median household income" or "poverty rate"',
      required: true,
    },
    {
      name: 'places',
      description:
        'The places to compare, comma-separated, e.g. "Anchorage, Fairbanks, Juneau"',
      required: true,
    },
  ]

  constructor() {
    super()
    this.handler = this.handler.bind(this)
  }

  get argsSchema() {
    return ComparePlacesArgsSchema
  }

  async handler(args: z.infer<typeof ComparePlacesArgsSchema>) {
    const { topic, places } = args

    const promptText = [
      `Compare ${topic} across these places: ${places}. Use the Census MCP Server tools:`,
      `1. resolve-geography-fips for each place, to get its for/in strings. If a name matches more than one geography, pick the one that fits and say which.`,
      `2. search-data-tables for "${topic}" with api_endpoint "acs/acs5", then list-table-variables on the best table to pick the cell code(s).`,
      `3. fetch-aggregate-data from acs/acs5 at the latest published vintage, one call per geography level (all places of the same level can share a call).`,
      `Present one row per place with the estimate and its margin of error. Treat two places as different only if their ranges (estimate +/- MOE) do not overlap, and say when a difference is within the margin of error. Mention any LOW RELIABILITY flags, and cite the table ID, dataset, and vintage.`,
    ].join('\n')

    return this.createPromptResponse(
      `Compare ${topic} across ${places}`,
      promptText,
    )
  }
}
