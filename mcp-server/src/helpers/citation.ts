// Redact by pattern, not by matching the configured key's exact value:
// value-matching silently leaks the live key whenever the URL encodes it
// differently than the env var (or the env var is missing entirely).
export function redactKey(url: string): string {
  return url.replace(/([?&])key=[^&]*/g, '$1key=REDACTED')
}

export function buildCitation(url: string): string {
  return `Source: U.S. Census Bureau Data API (${redactKey(url)})`
}
