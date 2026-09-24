import type { Knex } from 'knex';

/**
 * Schema moved to web-be (users/auth profile tables).
 * No-op placeholder keeps the shared Knex migration ledger consistent.
 */
export async function up(knex: Knex): Promise<void> {}

export async function down(knex: Knex): Promise<void> {}