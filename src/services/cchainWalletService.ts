import { privateKeyToAccount } from 'viem/accounts';
import { generatePrivateKey } from 'viem/accounts';
import { getAddress } from 'viem';
import db from '../db';
import { encryptPrivateKey, decryptPrivateKey, EncryptedPayload } from './custodialCipherService';
import { getBlockNumber } from './cchainRpcService';
import { OrderState } from '../models/types';

/**
 * The C-Chain custodial sell/deposit flow is enabled when the C-Chain RPC and
 * custodial key-encryption key are both configured.
 */
export function isCChainCustodialEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.CCHAIN_RPC_BASE_URL?.trim() && !!env.CUSTODIAL_KEY_ENCRYPTION_KEY?.trim();
}

export interface CustodialWalletRow {
  id: number;
  order_id: number;
  index: number;
  address: string;
  encrypted_private_key: EncryptedPayload | null;
  swept_navax_block: string | null;
  swept_usdt_txhash: string | null;
  last_scanned_block: string | null;
  native_baseline: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

/**
 * Provisions a unique Ethereum-compatible EOA (0x) custodial deposit wallet per
 * sell order. The private key is encrypted at rest (AES-256-GCM, AAD = order id)
 * and NEVER returned or logged; only the derived 0x address is exposed.
 *
 * Derivation uses freshly generated entropy (viem `generatePrivateKey`). A
 * stable bip32-style derivation from a master seed is an accepted alternative;
 * here each order draws fresh entropy and the derived key is persisted encrypted
 * so it does not need to be re-derived at sweep time.
 */
export async function provisionCustodialWallet(
  orderId: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const index = await nextWalletIndex(env);
  const privateKey = generatePrivateKey();

  const account = privateKeyToAccount(privateKey);
  const address = getAddress(account.address);

  const encrypted = encryptPrivateKey(privateKey, String(orderId), env);

  // Initialize the listener cursor: baseline 0 so any incoming AVAX is detected
  // across restarts, and the current block so USDT log scanning starts here.
  let currentBlock: string | null = null;
  try {
    currentBlock = (await getBlockNumber(env)).toString();
  } catch {
    currentBlock = null;
  }

  await db
    .insert({
      order_id: orderId,
      index,
      address,
      encrypted_private_key: encrypted,
      native_baseline: '0',
      last_scanned_block: currentBlock,
    })
    .into('custodial_wallets')
    .onConflict('order_id')
    .merge(['address', 'encrypted_private_key', 'updated_at']);

  return address;
}

async function nextWalletIndex(env: NodeJS.ProcessEnv): Promise<number> {
  const row = await db('custodial_wallets').max('index as maxIndex').first<{ maxIndex: number | null }>();
  const max = row?.maxIndex ?? -1;
  return Number(max) + 1;
}

/** Return the custodial deposit address for an order, or null if none exists. */
export async function getDepositAddress(orderId: number): Promise<string | null> {
  const row = await db('custodial_wallets').where({ order_id: orderId }).first<CustodialWalletRow>();
  return row ? row.address : null;
}

/** Return the decrypted privkey hex for a custodial address (in-memory only). */
export async function getPrivateKeyByAddress(
  address: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const row = await db('custodial_wallets').where({ address }).first<CustodialWalletRow>();
  return getPrivateKeyFromRow(row, env);
}

export async function getPrivateKeyByOrderId(
  orderId: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const row = await db('custodial_wallets').where({ order_id: orderId }).first<CustodialWalletRow>();
  return getPrivateKeyFromRow(row, env);
}

function getPrivateKeyFromRow(row: CustodialWalletRow | undefined, env: NodeJS.ProcessEnv): string | null {
  if (!row?.encrypted_private_key) return null;
  try {
    const payload =
      typeof row.encrypted_private_key === 'string'
        ? (JSON.parse(row.encrypted_private_key) as EncryptedPayload)
        : row.encrypted_private_key;
    return decryptPrivateKey(payload, String(row.order_id), env);
  } catch (err) {
    console.error(
      `[CchainWallet] Failed to decrypt custodial key for order ${row.order_id}: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * Order states in which a custodial deposit address can still legitimately
 * receive funds. Anything terminal (completed / failed / cancelled) is retired
 * from the listener's poll set.
 */
const OPEN_ORDER_STATES: number[] = [OrderState.CREATED, OrderState.PROCESSING];

/**
 * Custodial wallets whose owning order is still open — i.e. the addresses the
 * listener must poll for incoming deposits.
 *
 * This MUST stay filtered on the owning order's state. Returning every row
 * (as this function used to) meant a cancelled sell order's address was polled
 * forever, so the wallet list only ever grew and the oldest cancelled order
 * wedged the whole listener.
 */
export async function listOpenCustodialWallets(): Promise<CustodialWalletRow[]> {
  return db('custodial_wallets')
    .join('orders', 'orders.id', 'custodial_wallets.order_id')
    .whereIn('orders.order_state', OPEN_ORDER_STATES)
    .select('custodial_wallets.*')
    .orderBy('custodial_wallets.created_at', 'asc');
}

/**
 * Custodial wallets whose owning order reached a terminal state within
 * `watchMs`. These get a cheap balance check (not a log scan) so a deposit that
 * lands shortly after expiry/cancellation is still noticed and can be swept or
 * refunded, without pinning a log cursor open indefinitely.
 */
export async function listRetiredCustodialWallets(
  watchMs: number
): Promise<CustodialWalletRow[]> {
  return db('custodial_wallets')
    .join('orders', 'orders.id', 'custodial_wallets.order_id')
    .whereNotIn('orders.order_state', OPEN_ORDER_STATES)
    .where('orders.updated_at', '>=', new Date(Date.now() - watchMs))
    .select('custodial_wallets.*')
    .orderBy('custodial_wallets.created_at', 'asc');
}

export async function updateSweptState(
  orderId: number,
  patch: Partial<Pick<CustodialWalletRow, 'swept_navax_block' | 'swept_usdt_txhash'>>
): Promise<void> {
  await db('custodial_wallets')
    .where({ order_id: orderId })
    .update({ ...patch, updated_at: new Date() });
}

/** Persist the listener cursor (last scanned block / native baseline) for an address. */
export async function updateListenerCursor(
  address: string,
  patch: Partial<Pick<CustodialWalletRow, 'last_scanned_block' | 'native_baseline'>>
): Promise<void> {
  await db('custodial_wallets')
    .where({ address })
    .update({ ...patch, updated_at: new Date() });
}