import { DatabaseSync } from 'node:sqlite';
import path from 'path';

export type Exchange = 'binance' | 'okx' | 'bybit' | 'our';
export type TradeType = 'buy' | 'sell';

export interface P2PSnapshot {
  exchange: Exchange;
  trade_type: TradeType;
  asset: string;
  fiat: string;
  best_price: number;
}

export interface HistoryRow {
  created_at: number;
  buy: number | null;
  sell: number | null;
}

const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.resolve('p2p_prices.db');
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const P2P_PRICE_MAX_AGE_MS = Number(process.env.P2P_PRICE_MAX_AGE_MS || 120_000);

let db: DatabaseSync;
let dbReadOnly = false;

try {
  db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS p2p_prices (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      exchange   TEXT    NOT NULL,
      trade_type TEXT    NOT NULL,
      asset      TEXT    NOT NULL,
      fiat       TEXT    NOT NULL,
      best_price REAL    NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_p2p_exchange_created ON p2p_prices (exchange, created_at);
  `);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('readonly database') || msg.includes('read-only')) {
    console.warn(`[SnapshotDB] Database at ${DB_PATH} is read-only. Snapshot writes disabled: ${msg}`);
    dbReadOnly = true;
    // Open read-only so queries still work
    try {
      db = new DatabaseSync(DB_PATH, { readOnly: true });
    } catch {
      // Fallback: open default (may still fail on writes)
      db = new DatabaseSync(DB_PATH);
    }
  } else {
    throw err;
  }
}

// Seed mock data if table is empty or stale (latest record > 1 day old)
if (!dbReadOnly) {
  try {
    const countRow = db.prepare('SELECT COUNT(*) AS c FROM p2p_prices').get() as { c: number };
    const latestRow = db.prepare('SELECT MAX(created_at) AS ts FROM p2p_prices').get() as { ts: number | null };
    const isEmpty = countRow.c === 0 || latestRow.ts === null || Date.now() - latestRow.ts > 24 * 60 * 60 * 1000;

    if (isEmpty) {
      db.exec('DELETE FROM p2p_prices');
      const insert = db.prepare(
        'INSERT INTO p2p_prices (exchange, trade_type, asset, fiat, best_price, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const MOCK_CONFIG: Record<Exchange, { buyBase: number; sellBase: number; drift: number }> = {
        binance: { buyBase: 25_700, sellBase: 25_900, drift: 300 },
        okx:     { buyBase: 25_650, sellBase: 25_850, drift: 280 },
        bybit:   { buyBase: 25_680, sellBase: 25_880, drift: 320 },
        our:     { buyBase: 25_600, sellBase: 25_950, drift: 300 },
      };
      const MOCK_ASSETS = {
        USDT: { buyBase: 25_700, sellBase: 25_900, drift: 300 },
        AVAX: { buyBase: 3_700_000, sellBase: 3_750_000, drift: 40_000 },
      } as const;
      const now = Date.now();

      for (let day = 29; day >= 0; day--) {
        const ts = now - day * 24 * 60 * 60 * 1000;
        const noise = Math.sin(day * 0.7) * 0.5 + Math.cos(day * 1.3) * 0.5;
        for (const exchange of ['binance', 'okx', 'bybit', 'our'] as Exchange[]) {
          const { buyBase, sellBase, drift } = MOCK_CONFIG[exchange];
          insert.run(exchange, 'buy', 'USDT', 'VND', Math.round(buyBase + noise * drift), ts);
          insert.run(exchange, 'sell', 'USDT', 'VND', Math.round(sellBase + noise * drift), ts);
          const avax = MOCK_ASSETS.AVAX;
          insert.run(exchange, 'buy', 'AVAX', 'VND', Math.round(avax.buyBase + noise * avax.drift), ts);
          insert.run(exchange, 'sell', 'AVAX', 'VND', Math.round(avax.sellBase + noise * avax.drift), ts);
        }
      }

      for (let hour = 23; hour >= 0; hour--) {
        const ts = now - hour * 60 * 60 * 1000;
        const noise = Math.sin(hour * 0.9) * 0.5 + Math.cos(hour * 0.4) * 0.5;
        for (const exchange of ['binance', 'okx', 'bybit', 'our'] as Exchange[]) {
          const { buyBase, sellBase, drift } = MOCK_CONFIG[exchange];
          insert.run(exchange, 'buy', 'USDT', 'VND', Math.round(buyBase + noise * drift * 0.3), ts);
          insert.run(exchange, 'sell', 'USDT', 'VND', Math.round(sellBase + noise * drift * 0.3), ts);
          const avax = MOCK_ASSETS.AVAX;
          insert.run(exchange, 'buy', 'AVAX', 'VND', Math.round(avax.buyBase + noise * avax.drift * 0.3), ts);
          insert.run(exchange, 'sell', 'AVAX', 'VND', Math.round(avax.sellBase + noise * avax.drift * 0.3), ts);
        }
      }
    }
  } catch (err) {
    console.warn('[SnapshotDB] Failed to seed mock data:', err instanceof Error ? err.message : err);
  }
}

export function insertSnapshot(snapshot: P2PSnapshot): void {
  if (dbReadOnly) return;
  const now = Date.now();
  db.prepare(
    'INSERT INTO p2p_prices (exchange, trade_type, asset, fiat, best_price, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(snapshot.exchange, snapshot.trade_type, snapshot.asset, snapshot.fiat, snapshot.best_price, now);
  db.prepare('DELETE FROM p2p_prices WHERE created_at < ?').run(now - THIRTY_DAYS_MS);
}

export function getHistory(exchange: Exchange, days: number, asset: string = 'USDT'): HistoryRow[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const bucketMs = days === 1 ? 60_000 : 86_400_000;
  return db.prepare(`
    SELECT
      (created_at / ${bucketMs}) * ${bucketMs} AS created_at,
      MAX(CASE WHEN trade_type = 'buy'  THEN best_price END) AS buy,
      MAX(CASE WHEN trade_type = 'sell' THEN best_price END) AS sell
    FROM p2p_prices
    WHERE exchange = ? AND asset = ? AND created_at >= ?
    GROUP BY created_at / ${bucketMs}
    ORDER BY created_at ASC
  `).all(exchange, asset, cutoff) as unknown as HistoryRow[];
}

export function getLatestPrice(exchange: Exchange, tradeType: TradeType, asset: string = 'USDT'): number | null {
  const row = db.prepare(`
    SELECT best_price, created_at FROM p2p_prices
    WHERE exchange = ? AND trade_type = ? AND asset = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(exchange, tradeType, asset) as { best_price: number; created_at: number } | undefined;

  if (!row) return null;
  if (Date.now() - row.created_at > P2P_PRICE_MAX_AGE_MS) return null;
  return row.best_price;
}
