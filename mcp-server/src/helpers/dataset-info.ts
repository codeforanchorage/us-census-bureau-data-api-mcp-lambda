// Dataset-specific shape: human label + ACS 5-year collection window.
// Census vintages are deliberate, not stale -- but the 5-year ACS in
// particular is labeled with its end year and is regularly mistaken for
// "current year" data. Spelling out the collection window prevents that.

export interface DatasetShape {
  // Human-readable name shown in the provenance banner.
  label: string
  // If true, the dataset's vintage Y covers data collected over (Y-N+1)..Y.
  // E.g. ACS 5-year 2019 covers 2015-2019.
  collectionWindowYears?: number
  // Census category for vintage-staleness messaging.
  kind: 'acs1' | 'acs5' | 'decennial' | 'pep' | 'other'
}

export function classifyDataset(dataset: string): DatasetShape {
  const d = dataset.toLowerCase()

  if (d.includes('acs/acs5')) {
    return {
      label: 'ACS 5-Year Estimates',
      collectionWindowYears: 5,
      kind: 'acs5',
    }
  }
  if (d.includes('acs/acs3')) {
    return {
      label: 'ACS 3-Year Estimates',
      collectionWindowYears: 3,
      kind: 'acs5',
    }
  }
  if (d.includes('acs/acs1')) {
    return {
      label: 'ACS 1-Year Estimates',
      collectionWindowYears: 1,
      kind: 'acs1',
    }
  }
  if (d.includes('acs/acsse')) {
    return {
      label: 'ACS Supplemental Estimates (1-Year)',
      collectionWindowYears: 1,
      kind: 'acs1',
    }
  }
  if (d.includes('acs')) {
    return {
      label: 'American Community Survey',
      kind: 'acs5',
    }
  }
  if (d.startsWith('dec/') || d.includes('decennial')) {
    return { label: 'Decennial Census', kind: 'decennial' }
  }
  if (d.startsWith('pep')) {
    return { label: 'Population Estimates Program', kind: 'pep' }
  }

  return { label: dataset, kind: 'other' }
}

export interface VintageBanner {
  label: string
  yearLabel: string
  collectionWindow?: string
}

export function vintageBannerParts(
  dataset: string,
  year: number | string,
): VintageBanner {
  const shape = classifyDataset(dataset)
  const yearNum = typeof year === 'number' ? year : Number(year)
  const banner: VintageBanner = {
    label: shape.label,
    yearLabel: String(year),
  }
  if (
    shape.collectionWindowYears &&
    shape.collectionWindowYears > 1 &&
    Number.isFinite(yearNum)
  ) {
    const start = yearNum - shape.collectionWindowYears + 1
    banner.collectionWindow = `${start}-${yearNum}`
  }
  return banner
}

// Returns true if the requested year is more than `maxAgeYears` older than
// the current calendar year. Calendar year is passed in to keep the function
// pure for testing.
export function isStaleVintage(
  year: number | string,
  currentYear: number,
  maxAgeYears = 3,
): boolean {
  const y = typeof year === 'number' ? year : Number(year)
  if (!Number.isFinite(y)) return false
  return currentYear - y > maxAgeYears
}
