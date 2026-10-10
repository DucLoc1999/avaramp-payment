import type { Knex } from 'knex';

const schema = process.env.DB_SCHEMA ?? 'avaramp';

export async function up(knex: Knex): Promise<void> {
  const hasColumn = await knex.schema.withSchema(schema).hasColumn('orders', 'vnd_payout_ref');
  if (hasColumn) return;

  await knex.schema.withSchema(schema).alterTable('orders', (t) => {
    t.string('vnd_payout_ref', 100);
    t.string('vnd_payout_tx_id', 100);
    t.integer('vnd_payout_attempts').defaultTo(0);
    t.string('vnd_payout_error', 500);
    t.timestamp('vnd_payout_at');
    t.timestamp('next_vnd_payout_at');
  });

  await knex.schema.withSchema(schema).raw(`
    CREATE INDEX IF NOT EXISTS idx_orders_sell_payout
    ON ${schema}.orders (processing_state, next_vnd_payout_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema(schema).raw(`DROP INDEX IF EXISTS ${schema}.idx_orders_sell_payout`);
  await knex.schema.withSchema(schema).alterTable('orders', (t) => {
    t.dropColumn('vnd_payout_ref');
    t.dropColumn('vnd_payout_tx_id');
    t.dropColumn('vnd_payout_attempts');
    t.dropColumn('vnd_payout_error');
    t.dropColumn('vnd_payout_at');
    t.dropColumn('next_vnd_payout_at');
  });
}
