import type { Knex } from 'knex';

/**
 * 035: Drop the stale orders.user_id FK (added ad-hoc on shared DBs during the
 * pre-web-be migration era). orders.user_id is a logical, opaque reference to
 * web-be.users.id — a users row never exists in this service's schema, so the
 * FK violates inserts from the web channel (see migration 024 comment).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_user_id_foreign');
}

export async function down(knex: Knex): Promise<void> {
  // No-op: the constrained FK was never defined in migrations; recreating it
  // would break the documented "no FK" design.
}