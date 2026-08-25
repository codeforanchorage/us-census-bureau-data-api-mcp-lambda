import { z } from 'zod'

import {
  baseFields,
  baseProperties,
  geoFields,
  geoProperties,
  getFields,
  getProperties,
  yearField,
  yearProperty,
} from './table.schema.js'

export const TableSchema = {
  type: 'object',
  properties: {
    ...baseProperties,
    ...yearProperty,
    ...getProperties,
    ...geoProperties,
  },
  required: ['dataset', 'year', 'get'],
}

export const FetchAggregateDataToolSchema = z.object({
  ...baseFields,
  ...yearField,
  ...getFields,
  ...geoFields,
})

// Schema for structuredContent (emitted as outputSchema in tools/list).
// BINDING -- never declare a constraint real Census data can violate:
//  - estimates can be negative (net figures, medians of differences), so
//    no `minimum` anywhere;
//  - sentinel cells carry value: null plus an annotation code, never the
//    raw jam value as a number;
//  - FIPS/GEOID codes are strings (leading zeros are load-bearing);
//  - non-numeric variables (GEO_ID, text annotations) pass through as
//    strings, so `value` admits string as well as number and null.
export const FetchAggregateDataOutputSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'object',
      description: 'Echo of the request as sent to the Census API.',
      properties: {
        dataset: { type: 'string' },
        year: { type: 'number' },
        get: {
          type: 'string',
          description:
            'The effective get= parameter, including auto-paired MOE fields.',
        },
        for: { type: ['string', 'null'] },
        in: { type: ['string', 'null'] },
        ucgid: { type: ['string', 'null'] },
        predicates: { type: ['object', 'null'] },
      },
      required: ['dataset', 'year', 'get', 'for', 'in', 'ucgid', 'predicates'],
    },
    source: {
      type: 'object',
      description: 'Provenance: cite this with any number reported.',
      properties: {
        dataset: { type: 'string' },
        vintage: { type: 'string' },
        label: { type: 'string' },
        collection_window: {
          type: ['string', 'null'],
          description:
            'For multi-year surveys, the span the vintage actually covers (e.g. "2019-2023" for ACS 5-year 2023). null for single-year data.',
        },
        citation_url: {
          type: 'string',
          description: 'The API request URL with the key redacted.',
        },
      },
      required: [
        'dataset',
        'vintage',
        'label',
        'collection_window',
        'citation_url',
      ],
    },
    total_count: {
      type: 'integer',
      description: 'Rows the query returned upstream.',
    },
    shown_count: {
      type: 'integer',
      description:
        'Rows included in records below. Less than total_count when the display cap truncated the result (see the TRUNCATED caveat).',
    },
    variables: {
      type: 'array',
      description: 'One-time legend for the cell variables.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          label: { type: ['string', 'null'] },
          moe_variable: {
            type: ['string', 'null'],
            description:
              'The margin-of-error companion merged into this variable\'s cells, when one exists.',
          },
        },
        required: ['name', 'label', 'moe_variable'],
      },
    },
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          geography: {
            type: 'object',
            properties: {
              name: { type: ['string', 'null'] },
              codes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    level: { type: 'string' },
                    code: {
                      type: 'string',
                      description:
                        'FIPS/GEOID piece as a string; leading zeros are significant.',
                    },
                  },
                  required: ['level', 'code'],
                },
              },
            },
            required: ['name', 'codes'],
          },
          cells: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                variable: { type: 'string' },
                value: {
                  type: ['number', 'string', 'null'],
                  description:
                    'null with a non-null annotation means the Census suppressed or did not publish this cell -- it is NOT a zero. Estimates can be negative.',
                },
                annotation: {
                  type: ['string', 'null'],
                  description:
                    'Sentinel code when the value is not a measurement (e.g. SUPPRESSED, NOT_APPLICABLE).',
                },
                moe: {
                  type: ['number', 'null'],
                  description:
                    'Margin of error at the 90% confidence level. Report it with the estimate, not separately.',
                },
                moe_annotation: { type: ['string', 'null'] },
                cv_percent: { type: ['number', 'null'] },
                low_reliability: {
                  type: 'boolean',
                  description:
                    'true when CV exceeds the reliability threshold; treat the cell as an MOE band, not a point estimate.',
                },
              },
              required: ['variable', 'value', 'annotation'],
            },
          },
        },
        required: ['geography', 'cells'],
      },
    },
    caveats: {
      type: 'array',
      description:
        'Machine-readable qualifications with stable codes (TRUNCATED, LOW_RELIABILITY, SINGLE_UNIT_CLAIM, SUPPRESSED_VALUES, STALE_VINTAGE, MOE_AUTO_PAIRED). Every message also appears in the text content.',
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
    'source',
    'total_count',
    'shown_count',
    'variables',
    'records',
    'caveats',
  ],
}

export type TableArgs = z.infer<typeof FetchAggregateDataToolSchema>
