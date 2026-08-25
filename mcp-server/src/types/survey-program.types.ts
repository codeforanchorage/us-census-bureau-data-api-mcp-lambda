// Row shapes returned by the list_survey_programs() /
// list_survey_components(TEXT) database functions (ported from upstream
// PR #141).
export interface SurveyProgramRow {
  program_label: string
  program_string: string
  description: string | null
  table_count: number
}

export interface SurveyComponentRow {
  component_label: string
  component_string: string
  api_endpoint: string
  frequency: string | null
  frequency_notes: string | null
  vintage_start: number | null
  vintage_end: number | null
  // null when no datasets are linked (nothing to compare), true when the
  // published year range has holes.
  has_gaps: boolean | null
  table_count: number
  description: string | null
}
