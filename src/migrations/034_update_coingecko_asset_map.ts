import type { Knex } from 'knex';

/**
 * 034: Refresh the CoinGecko source asset map for the current AVAX/USDT assets.
 *
 * The persisted `rate_coingecko_source` config still carried the legacy
 * Stellar-era map ({ XLM, USDC, AVAX }), which broke USDT price lookups
 * ("No CoinGecko mapping for USDT"). Overwrite it with a map that covers the
 * two supported assets; defaults are also merged in code as a fallback.
 */
export async function up(knex: Knex): Promise<void> {
  const value = JSON.stringify({
    api_key: null,
    spread: 100,
    cache_ttl_ms: 30000,
    asset_map: {
      AVAX: 'avalanche-2',
      USDT: 'tether',
    },
  });

  await knex('config').where({ key: 'rate_coingecko_source' }).update({ value });
}

export async function down(knex: Knex): Promise<void> {
  // No-op: previous value is not restored automatically.
}