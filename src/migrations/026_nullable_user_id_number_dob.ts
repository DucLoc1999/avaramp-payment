import type { Knex } from 'knex';

/**
 * Schema moved to web-be (users table: nullable id_number / dob).
 * No-op placeholder keeps the shared Knex migration ledger consistent:
 * the KMS/DB ledger still records `026_nullable_user_id_number_dob` as
 * applied, so the file must exist or knex validation fails on startup.
 */
export async function up(knex: Knex): Promise<void> {}

export async function down(knex: Knex): Promise<void> {}