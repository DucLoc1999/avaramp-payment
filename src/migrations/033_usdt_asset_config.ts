import type { Knex } from 'knex';

const schema = process.env.DB_SCHEMA ?? 'avaramp';

/**
 * 033: Seed config token rows for the native USDT (ERC-20) asset.
 *
 * Following 028 (which seeded the native AVAX asset), this idempotently upserts
 * the USDT buy/sell spread, fee rate, min fee, and order amount bounds so the
 * C-Chain USDT p2p flow has price config from day one.
 */
export async function up(knex: Knex): Promise<void> {
  const rows = [
    { key: 'USDT_buy', spread: 50, fee_rate: 0.008, min_fee: 5000, min_order_amount: 1, max_order_amount: 10000, source: 'coingecko' },
    { key: 'USDT_sell', spread: 50, fee_rate: 0.008, min_fee: 5000, min_order_amount: 1, max_order_amount: 10000, source: 'coingecko' },
  ];

  for (const row of rows) {
    const value = JSON.stringify({
      spread: row.spread,
      fee_rate: row.fee_rate,
      min_fee: row.min_fee,
      min_order_amount: row.min_order_amount,
      max_order_amount: row.max_order_amount,
      source: row.source,
    });

    const existing = await knex('config').where({ key: row.key }).first();
    if (existing) {
      await knex('config').where({ key: row.key }).update({ value });
    } else {
      await knex('config').insert({
        key: row.key,
        value,
        description: 'USDT coingecko config (Avalanche C-Chain ERC-20 asset)',
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('config').whereIn('key', ['USDT_buy', 'USDT_sell']).delete();
}