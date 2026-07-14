export function buildCitation(url: string): string {
  // Redact by pattern, not by matching the configured key's exact value:
  // value-matching silently leaks the live key whenever the URL encodes it
  // differently than the env var (or the env var is missing entirely).
  const urlWithoutAPIKey = url.replace(/([?&])key=[^&]*/g, '$1key=REDACTED')
  return `Source: U.S. Census Bureau Data API (${urlWithoutAPIKey})`
}
