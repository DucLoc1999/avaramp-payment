import { isAddress, getAddress } from 'viem';

export interface CchainConfig {
  rpcBaseUrl: string;
  chainId: number;
  nativeUsdtAddress: `0x${string}`;
  depositConfirmations: number;
  pollIntervalMs: number;
  minSweepThreshold: bigint;
  masterWalletPrivateKey: string;
  encryptKey: string;
  listenerFallbackUrl: string;
  listenerFallbackAuthToken: string;
  /** Raw private key for the C-Chain payout wallet (dev/local fallback). */
  payoutWalletPrivateKey: string;
  /**
   * When true and no explicit payout key is set, the Master Wallet key also signs
   * buy payouts ("one wallet" deployment). Off by default so KMS is not shadowed
   * silently.
   */
  payoutUseMasterWallet: boolean;
  /** Blocks to wait before treating a buy payout as final. */
  payoutConfirmations: number;
  /** AVAX (wei) that must remain available to pay gas for USDT payouts. */
  avaxGasReserveWei: bigint;
  /** Max blocks per `eth_getLogs` call; keeps each RPC request small enough to answer. */
  logScanChunkBlocks: bigint;
  /** Hard cap on the block span scanned per wallet per poll. */
  logScanMaxSpanBlocks: bigint;
  /** How long a closed order's custodial address is still watched for late deposits. */
  closedWalletWatchMs: number;
}

/**
 * Default native USDT contract on Avalanche C-Chain. Configurable via
 * CCHAIN_NATIVE_USDT_ADDRESS for testnet/mirror deployments.
 */
export const DEFAULT_NATIVE_USDT_ADDRESS = '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7';

/**
 * The C-Chain is the EVM side of Avalanche. Unlike the X-Chain (AVM UTXO model),
 * it speaks standard EVM JSON-RPC. This loader validates the C-Chain connection
 * settings used by the custodial sell-sweep flow.
 */
export function loadCchainConfig(env: NodeJS.ProcessEnv = process.env): CchainConfig {
  const rpcBaseUrl = env.CCHAIN_RPC_BASE_URL?.trim();
  if (!rpcBaseUrl) {
    throw new Error('Missing CCHAIN_RPC_BASE_URL configuration');
  }

  const rawChainId = env.CCHAIN_CHAIN_ID?.trim() || '43113';
  if (!/^\d+$/.test(rawChainId)) {
    throw new Error(`Invalid CCHAIN_CHAIN_ID '${rawChainId}': must be an integer`);
  }
  const chainId = Number(rawChainId);

  const rawUsdt = env.CCHAIN_NATIVE_USDT_ADDRESS?.trim() || DEFAULT_NATIVE_USDT_ADDRESS;
  if (!isAddress(rawUsdt)) {
    throw new Error(`Invalid CCHAIN_NATIVE_USDT_ADDRESS '${rawUsdt}': must be a valid 0x EVM address`);
  }

  const rawConfirmations = env.CCHAIN_DEPOSIT_CONFIRMATIONS?.trim() || '25';
  if (!/^\d+$/.test(rawConfirmations)) {
    throw new Error(`Invalid CCHAIN_DEPOSIT_CONFIRMATIONS '${rawConfirmations}': must be an integer`);
  }
  const depositConfirmations = Number(rawConfirmations);

  const rawPoll = env.CCHAIN_POLL_INTERVAL_MS?.trim() || '5000';
  if (!/^\d+$/.test(rawPoll)) {
    throw new Error(`Invalid CCHAIN_POLL_INTERVAL_MS '${rawPoll}': must be an integer`);
  }
  const pollIntervalMs = Number(rawPoll);

  const rawThreshold = env.CCHAIN_MIN_SWEEP_THRESHOLD?.trim() || '0';
  if (!/^\d+$/.test(rawThreshold)) {
    throw new Error(`Invalid CCHAIN_MIN_SWEEP_THRESHOLD '${rawThreshold}': must be a non-negative integer`);
  }
  const minSweepThreshold = BigInt(rawThreshold);

  const masterWalletPrivateKey = env.MASTER_WALLET_PRIVATE_KEY?.trim() || '';
  const encryptKey = env.CUSTODIAL_KEY_ENCRYPTION_KEY?.trim() || '';

  const payoutWalletPrivateKey = env.CCHAIN_PAYOUT_WALLET_PRIVATE_KEY?.trim() || '';
  if (payoutWalletPrivateKey && !/^0x[0-9a-fA-F]{64}$/.test(payoutWalletPrivateKey)) {
    throw new Error('Invalid CCHAIN_PAYOUT_WALLET_PRIVATE_KEY: must be a 0x-prefixed 32-byte hex string');
  }
  const payoutUseMasterWallet = env.CCHAIN_PAYOUT_USE_MASTER_WALLET?.trim().toLowerCase() === 'true';

  const rawPayoutConfirmations = env.CCHAIN_PAYOUT_CONFIRMATIONS?.trim() || '1';
  if (!/^\d+$/.test(rawPayoutConfirmations)) {
    throw new Error(`Invalid CCHAIN_PAYOUT_CONFIRMATIONS '${rawPayoutConfirmations}': must be an integer`);
  }
  const payoutConfirmations = Number(rawPayoutConfirmations);

  const rawGasReserve = env.CCHAIN_AVAX_GAS_RESERVE_WEI?.trim() || '10000000000000000';
  if (!/^\d+$/.test(rawGasReserve)) {
    throw new Error(`Invalid CCHAIN_AVAX_GAS_RESERVE_WEI '${rawGasReserve}': must be a non-negative integer`);
  }
  const avaxGasReserveWei = BigInt(rawGasReserve);

  const logScanChunkBlocks = BigInt(
    parsePositiveInt(env.CCHAIN_LOG_SCAN_CHUNK_BLOCKS, 2_000, 'CCHAIN_LOG_SCAN_CHUNK_BLOCKS')
  );
  const logScanMaxSpanBlocks = BigInt(
    parsePositiveInt(env.CCHAIN_LOG_SCAN_MAX_SPAN_BLOCKS, 20_000, 'CCHAIN_LOG_SCAN_MAX_SPAN_BLOCKS')
  );
  if (logScanMaxSpanBlocks < logScanChunkBlocks) {
    throw new Error(
      `CCHAIN_LOG_SCAN_MAX_SPAN_BLOCKS (${logScanMaxSpanBlocks}) must be >= ` +
        `CCHAIN_LOG_SCAN_CHUNK_BLOCKS (${logScanChunkBlocks})`,
    );
  }
  const closedWalletWatchMs = parsePositiveInt(
    env.CCHAIN_CLOSED_WALLET_WATCH_MS,
    7 * 24 * 60 * 60 * 1000,
    'CCHAIN_CLOSED_WALLET_WATCH_MS',
  );

  return {
    rpcBaseUrl,
    chainId,
    nativeUsdtAddress: getAddress(rawUsdt),
    depositConfirmations,
    pollIntervalMs,
    minSweepThreshold,
    masterWalletPrivateKey,
    encryptKey,
    listenerFallbackUrl: env.CCHAIN_LISTENER_FALLBACK_URL?.trim() || '',
    listenerFallbackAuthToken: env.CCHAIN_LISTENER_FALLBACK_AUTH_TOKEN?.trim() || '',
    payoutWalletPrivateKey,
    payoutUseMasterWallet,
    payoutConfirmations,
    avaxGasReserveWei,
    logScanChunkBlocks,
    logScanMaxSpanBlocks,
    closedWalletWatchMs,
  };
}

/** Parse a strictly positive integer env var, falling back to `fallback`. */
function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) === 0) {
    throw new Error(`Invalid ${name} '${value}': must be a positive integer`);
  }
  return Number(value);
}

/** Master Wallet public address derived from its private key, when configured. */
export function masterWalletAddress(env: NodeJS.ProcessEnv = process.env): `0x${string}` | null {
  const key = env.MASTER_WALLET_PRIVATE_KEY?.trim();
  if (!key) return null;
  try {
    const { privateKeyToAccount } = require('viem/accounts');
    return privateKeyToAccount(key as `0x${string}`).address;
  } catch {
    return null;
  }
}