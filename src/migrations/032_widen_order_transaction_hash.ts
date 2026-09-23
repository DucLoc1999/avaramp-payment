import type { Knex } from 'knex';

const schema = process.env.DB_SCHEMA ?? 'avaramp';

export async function up(knex: Knex): Promise<void> {
  // C-Chain tx hashes are 0x-prefixed (66 chars); the column was varchar(64),
  // which made the payout service fail to persist transaction_hash after broadcast
  // ("value too long for type character varying(64)").
  await knex.schema.withSchema(schema).alterTable('orders', (t) => {
    t.string('transaction_hash', 66).alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema(schema).alterTable('orders', (t) => {
    t.string('transaction_hash', 64).alter();
  });
}