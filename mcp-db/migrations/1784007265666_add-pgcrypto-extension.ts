import { MigrationBuilder } from 'node-pg-migrate'

// Ported from upstream PR #135. generate_cache_hash() calls digest(), which
// lives in pgcrypto; without the extension every cache write fails at runtime.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public`)
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP EXTENSION IF EXISTS pgcrypto`)
}
