import { parseUnits, formatUnits } from 'viem';
import { DEFAULT_NATIVE_USDT_ADDRESS } from '../config/cchain';
import { getNativeUsdtContract, getPublicClient, parseAbi } from './cchainRpcService';

export const AVAX_DECIMALS = 18;
export const USDT_DECIMALS_FALLBACK = 6;

const ERC20_DECIMALS_ABI = parseAbi(['function decimals() view returns (uint8)']);

/** The configured native USDT contract address, falling back to the Avalanche default. */
export function configuredUsdtAddress(env: NodeJS.ProcessEnv = process.env): string {
  return env.CCHAIN_NATIVE_USDT_ADDRESS?.trim() || DEFAULT_NATIVE_USDT_ADDRESS;
}

/** Whether a partner-supplied token address is the configured native USDT contract. */
export function isUsdtToken(tokenAddress: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!tokenAddress || !tokenAddress.trim()) return false;
  return tokenAddress.trim().toLowerCase() === configuredUsdtAddress(env).toLowerCase();
}

/** Whether an order targets native AVAX (no token contract). */
export function isNativeAvaxToken(tokenAddress: string | null | undefined): boolean {
  return !tokenAddress || tokenAddress.trim() === '';
}

/**
 * Resolve decimals for an order asset. USDT is 6 on Avalanche; AVAX is 18.
 * Falls back to the USDT constant when the asset code is USDT even if the
 * token address was omitted.
 */
export function decimalsForAsset(
  assetCode: string | null | undefined,
  tokenAddress: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  if (isUsdtToken(tokenAddress, env)) return USDT_DECIMALS_FALLBACK;
  if ((assetCode || '').trim().toUpperCase() === 'USDT') return USDT_DECIMALS_FALLBACK;
  return AVAX_DECIMALS;
}

/** Convert a decimal string amount to base units, rejecting invalid or over-precise input. */
export function toUnits(amount: string, decimals: number): bigint {
  const raw = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('AMOUNT_INVALID_FORMAT');
  }
  const fraction = raw.includes('.') ? raw.split('.')[1].replace(/0+$/, '') : '';
  if (fraction.length > decimals) {
    throw new Error('AMOUNT_TOO_PRECISE');
  }
  return parseUnits(raw, decimals);
}

/** Convert base units back to a decimal string. */
export function fromUnits(units: bigint, decimals: number): string {
  return formatUnits(units, decimals);
}

/**
 * Read `decimals()` from the configured USDT contract. Used at startup to
 * verify the deployed contract matches the expected precision; callers should
 * fail closed on mismatch.
 */
export async function fetchUsdtDecimals(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const client = getPublicClient(env);
  const value = await client.readContract({
    address: getNativeUsdtContract(env),
    abi: ERC20_DECIMALS_ABI,
    functionName: 'decimals',
  });
  return Number(value);
}
