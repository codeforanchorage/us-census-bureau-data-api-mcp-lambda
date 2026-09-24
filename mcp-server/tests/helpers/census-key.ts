// Integration tests that call the real api.census.gov need a key: keyless
// requests are redirected to an HTML "missing key" page, which surfaces as
// a confusing "non-JSON response" failure. Gate those tests on the key so a
// keyless run reports them as skipped instead. Set CENSUS_API_KEY in the
// environment or in mcp-server/.env (vitest.config.ts loads it).
export const hasCensusApiKey = Boolean(process.env.CENSUS_API_KEY)

export const NEEDS_KEY = '(needs CENSUS_API_KEY)'
