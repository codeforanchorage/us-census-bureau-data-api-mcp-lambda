import { z } from 'zod'

import { ACS_PRODUCTS } from '../helpers/acs-product.js'
import { INDICATORS, INDICATOR_IDS } from '../helpers/indicators.js'
import {
  FetchAggregateDataOutputSchema,
  PRODUCT_DESCRIPTION,
} from './fetch-aggregate-data.schema.js'
import { geoFields, geoProperties } from './table.schema.js'

const INDICATOR_LIST = INDICATOR_IDS.map(
  (id) => `${id} (${INDICATORS[id].unit})`,
).join(', ')

export const GetIndicatorInputSchema = {
  type: 'object',
  properties: {
    indicator: {
      type: 'string',
      enum: [...INDICATOR_IDS],
      description: `Which indicator: ${INDICATOR_LIST}.`,
    },
    year: {
      type: 'number',
      description:
        'Vintage. Omit for the latest published one. decennial_population is 2020 only.',
      examples: [2024],
    },
    product: {
      type: 'string',
      enum: [...ACS_PRODUCTS],
      description: `${PRODUCT_DESCRIPTION} Defaults to "auto" here. Ignored for decennial_population.`,
    },
    ...geoProperties,
  },
  required: ['indicator'],
}

export const GetIndicatorArgsSchema = z.object({
  indicator: z.enum(INDICATOR_IDS as [string, ...string[]]),
  year: z.number().int().optional(),
  product: z.enum(['auto', '1-year', '5-year']).optional(),
  ...geoFields,
})

export type GetIndicatorArgs = z.infer<typeof GetIndicatorArgsSchema>

// The fetch-aggregate-data envelope plus an `indicator` block naming what
// was measured. Same binding rules (no minimums, FIPS as strings, null
// values with annotations for sentinels).
export const GetIndicatorOutputSchema = {
  ...FetchAggregateDataOutputSchema,
  properties: {
    indicator: {
      type: 'object',
      description: 'What was measured, and the published cell it came from.',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        unit: { type: 'string' },
        variable: {
          type: 'string',
          description:
            'The Census cell code, verified against its published label.',
        },
        published_label: {
          type: 'string',
          description: "The variable's label in the vintage actually queried.",
        },
      },
      required: [
        'id',
        'title',
        'description',
        'unit',
        'variable',
        'published_label',
      ],
    },
    ...FetchAggregateDataOutputSchema.properties,
  },
  required: ['indicator', ...FetchAggregateDataOutputSchema.required],
}
