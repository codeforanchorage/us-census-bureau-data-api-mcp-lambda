// Headline indicators served by get-indicator: one published Census cell
// each, so the value and its margin of error come straight from the
// Bureau -- nothing is derived or recomputed here.
//
// Every entry carries a LABEL PATTERN that the variable's published label
// must match in the vintage actually queried. Cell codes in subject and
// profile tables are reused for different statistics across years
// (verified 2026-11-08 against the live variables endpoints):
//   - S1501_C02_015E is MALE bachelor's-or-higher in 2010-2014
//   - S2701_C05_001E is percent INSURED in 2014
//   - DP04_0046PE    is RENTER-occupied in 2010-2014
// so a code alone is not trustworthy; a mismatch is refused, never served.

export type IndicatorUnit =
  | 'people'
  | 'years'
  | 'dollars'
  | 'percent'
  | 'minutes'

export type IndicatorSpec = {
  title: string
  description: string
  unit: IndicatorUnit
  variable: string
  // ACS table family suffix ('' detailed, '/subject', '/profile'), or the
  // fixed decennial dataset.
  source:
    | { kind: 'acs'; suffix: '' | '/subject' | '/profile' }
    | {
        kind: 'decennial'
        dataset: string
        year: number
      }
  label: RegExp
}

export const INDICATORS = {
  population: {
    title: 'Total population',
    description: 'Total population (ACS estimate).',
    unit: 'people',
    variable: 'B01003_001E',
    source: { kind: 'acs', suffix: '' },
    label: /^Estimate!!Total:?$/,
  },
  median_age: {
    title: 'Median age',
    description: 'Median age of the total population.',
    unit: 'years',
    variable: 'B01002_001E',
    source: { kind: 'acs', suffix: '' },
    label: /^Estimate!!Median age( --)?!!Total:?$/,
  },
  median_household_income: {
    title: 'Median household income',
    description:
      'Median household income in the past 12 months, in inflation-adjusted dollars of the vintage year.',
    unit: 'dollars',
    variable: 'B19013_001E',
    source: { kind: 'acs', suffix: '' },
    label: /^Estimate!!Median household income in the past 12 months/i,
  },
  per_capita_income: {
    title: 'Per capita income',
    description:
      'Per capita income in the past 12 months, in inflation-adjusted dollars of the vintage year.',
    unit: 'dollars',
    variable: 'B19301_001E',
    source: { kind: 'acs', suffix: '' },
    label: /^Estimate!!Per capita income in the past 12 months/i,
  },
  poverty_rate: {
    title: 'Poverty rate',
    description:
      'Percent of the population for whom poverty status is determined that is below the poverty level.',
    unit: 'percent',
    variable: 'S1701_C03_001E',
    source: { kind: 'acs', suffix: '/subject' },
    label:
      /Percent below poverty level!!.*Population for whom poverty status is determined$/,
  },
  unemployment_rate: {
    title: 'Unemployment rate (ACS)',
    description:
      'Unemployment rate for the population 16 years and over, from the ACS (not the BLS LAUS rate).',
    unit: 'percent',
    variable: 'S2301_C04_001E',
    source: { kind: 'acs', suffix: '/subject' },
    label: /Unemployment rate!!.*Population 16 years and over$/,
  },
  bachelors_or_higher: {
    title: "Bachelor's degree or higher",
    description:
      "Percent of the population 25 years and over with a bachelor's degree or higher.",
    unit: 'percent',
    variable: 'S1501_C02_015E',
    source: { kind: 'acs', suffix: '/subject' },
    label: /^(?!.*\b(?:Fem|M)ale\b).*Percent.*bachelor's degree or higher$/i,
  },
  uninsured_rate: {
    title: 'Uninsured rate',
    description:
      'Percent of the civilian noninstitutionalized population without health insurance.',
    unit: 'percent',
    variable: 'S2701_C05_001E',
    source: { kind: 'acs', suffix: '/subject' },
    label: /Percent Uninsured!!.*Civilian noninstitutionalized population$/,
  },
  mean_commute_minutes: {
    title: 'Mean travel time to work',
    description:
      'Mean travel time to work, in minutes, for workers 16 and over.',
    unit: 'minutes',
    variable: 'DP03_0025E',
    source: { kind: 'acs', suffix: '/profile' },
    label: /Mean travel time to work \(minutes\)$/,
  },
  median_gross_rent: {
    title: 'Median gross rent',
    description:
      'Median gross rent (contract rent plus utilities), in dollars per month.',
    unit: 'dollars',
    variable: 'B25064_001E',
    source: { kind: 'acs', suffix: '' },
    label: /^Estimate!!Median gross rent$/,
  },
  median_home_value: {
    title: 'Median home value',
    description: 'Median value of owner-occupied housing units, in dollars.',
    unit: 'dollars',
    variable: 'B25077_001E',
    source: { kind: 'acs', suffix: '' },
    label: /^Estimate!!Median value \(dollars\)$/,
  },
  owner_occupied_share: {
    title: 'Owner-occupied share',
    description: 'Percent of occupied housing units that are owner-occupied.',
    unit: 'percent',
    variable: 'DP04_0046PE',
    source: { kind: 'acs', suffix: '/profile' },
    label:
      /^Percent( Estimate)?!!HOUSING TENURE!!Occupied housing units!!Owner-occupied$/,
  },
  median_housing_cost: {
    title: 'Median monthly housing costs',
    description:
      'Median monthly housing costs for occupied units (owners and renters), in dollars.',
    unit: 'dollars',
    variable: 'B25105_001E',
    source: { kind: 'acs', suffix: '' },
    label: /^Estimate!!Median monthly housing costs$/,
  },
  decennial_population: {
    title: 'Total population (2020 Census count)',
    description:
      'Total population from the 2020 Decennial Census (a full count, no margin of error).',
    unit: 'people',
    variable: 'P1_001N',
    source: { kind: 'decennial', dataset: 'dec/dhc', year: 2020 },
    label: /Total:?$/,
  },
} satisfies Record<string, IndicatorSpec>

export type IndicatorId = keyof typeof INDICATORS
export const INDICATOR_IDS = Object.keys(INDICATORS) as IndicatorId[]
