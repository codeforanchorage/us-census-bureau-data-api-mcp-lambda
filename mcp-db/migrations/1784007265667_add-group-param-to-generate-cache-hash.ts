import { MigrationBuilder } from 'node-pg-migrate'

// Ported from upstream PR #135 with one fix: "group" is COALESCEd before
// concatenation. Upstream concatenates it raw, so a NULL group (variable-only
// queries) makes the whole expression NULL — lookups never match and every
// such query inserts a fresh dead row (NULLs never collide in the unique
// constraint backing ON CONFLICT).
export const generateCacheHashNewVersion = `
    CREATE OR REPLACE FUNCTION generate_cache_hash(
        dataset_param TEXT,
        "group" TEXT,
        year INTEGER,
        variables TEXT[],
        geography_spec JSONB
    )
    RETURNS TEXT AS $$
    BEGIN
        RETURN encode(
            digest(
                dataset_param || COALESCE("group", '') || year::TEXT || array_to_string(variables, ',') || geography_spec::TEXT,
                'sha256'
            ),
            'hex'
        );
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `

export const generateCacheHashOldVersion = `
    CREATE OR REPLACE FUNCTION generate_cache_hash(
        dataset_code TEXT,
        year INTEGER,
        variables TEXT[],
        geography_spec JSONB
    )
    RETURNS TEXT AS $$
    BEGIN
        RETURN encode(
            digest(
                dataset_code || year::TEXT || array_to_string(variables, ',') || geography_spec::TEXT,
                'sha256'
            ),
            'hex'
        );
    END;
    $$ LANGUAGE plpgsql IMMUTABLE;
  `

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Drop the existing function first because the signature (parameter list) is changing
  pgm.sql(
    'DROP FUNCTION IF EXISTS generate_cache_hash(TEXT, INTEGER, TEXT[], JSONB)',
  )

  // Create the updated function with 'dataset_param' and 'group' parameters
  pgm.sql(generateCacheHashNewVersion)
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop the updated function
  pgm.sql(
    'DROP FUNCTION IF EXISTS generate_cache_hash(TEXT, TEXT, INTEGER, TEXT[], JSONB)',
  )

  // Recreate the original function
  pgm.sql(generateCacheHashOldVersion)
}
