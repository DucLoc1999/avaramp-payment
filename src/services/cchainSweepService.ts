import { getAddress, hexToSignature, type Address } from 'viem';
import { http, createWalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadCchainConfig } from '../config/cchain';
import {
  getPublicClient,
  getMasterWalletClient,
  getNativeUsdtContract,
  getBalance,
  getCchainChain,
  USDT_ABI,
} from './cchainRpcService';
import { getPrivateKeyByAddress } from './cchainWalletService';

export const NATIVE_TRANSFER_GAS = 21000n;
/** Buffer added to base price for deterministic landing. */
export const TIP_BUFFER = 3_000_000_000n; // 3 gwei

export interface TxOverrides {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  type?: 'eip1559';
}

export interface NativeSweepDecision {
  canSend: boolean;
  amountToSend: bigint;
  gasCost: bigint;
  reason?: 'BELOW_SWEEP_THRESHOLD' | 'INSUFFICIENT_GAS' | 'OK';
}

/**
 * Pure decision logic for a native AVAX sweep. Gas cost = 21000 gas × fee; we
 * send (balance − gasCost) only when the balance exceeds both the configured
 * threshold and the gas cost.
 */
export function computeNativeSweep(
  balance: bigint,
  maxFeePerGas: bigint,
  minThreshold: bigint
): NativeSweepDecision {
  const gasCost = NATIVE_TRANSFER_GAS * maxFeePerGas;
  if (balance <= minThreshold) {
    return { canSend: false, amountToSend: 0n, gasCost, reason: 'BELOW_SWEEP_THRESHOLD' };
  }
  if (balance <= gasCost) {
    return { canSend: false, amountToSend: 0n, gasCost, reason: 'INSUFFICIENT_GAS' };
  }
  return { canSend: true, amountToSend: balance - gasCost, gasCost, reason: 'OK' };
}

/**
 * Build EIP-1559 gas fields for a C-Chain transaction. Always sets both
 * maxFeePerGas and maxPriorityFeePerGas (never a legacy gasPrice).
 */
export async function buildTxOverrides(
  env: NodeJS.ProcessEnv = process.env
): Promise<TxOverrides> {
  const client = getPublicClient(env);
  const tip = await client.estimateMaxPriorityFeePerGas();
  const maxPriorityFeePerGas = tip + TIP_BUFFER;
  const block = await client.getBlock();
  const baseFee = block.baseFeePerGas ?? 25_000_000_000n;
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas, type: 'eip1559' };
}

export interface SweepResult {
  success: boolean;
  txHash?: string;
  error?: string;
  amountMoved: bigint;
}

/** Build a wallet client from a private key on the configured C-Chain. */
async function walletClientFromKey(privateKey: string, env: NodeJS.ProcessEnv) {
  const cfg = loadCchainConfig(env);
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return createWalletClient({
    account,
    chain: getCchainChain(env),
    transport: http(cfg.rpcBaseUrl),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

async function masterAddress(env: NodeJS.ProcessEnv): Promise<Address> {
  const cfg = loadCchainConfig(env);
  if (!cfg.masterWalletPrivateKey) throw new Error('MASTER_WALLET_PRIVATE_KEY is not configured');
  return privateKeyToAccount(cfg.masterWalletPrivateKey as `0x${string}`).address;
}

/**
 * Sweep native AVAX from a custodial address to the Master Wallet. The transfer
 * is signed by the custodial key and pays its own gas from the custodial
 * balance: sends (balance - gasCost) where gasCost = 21000 * maxFeePerGas.
 */
export async function sweepNativeAvax(
  address: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<SweepResult> {
  const cfg = loadCchainConfig(env);
  if (!cfg.masterWalletPrivateKey) {
    return { success: false, error: 'MASTER_WALLET_NOT_CONFIGURED', amountMoved: 0n };
  }

  const addr = getAddress(address);
  const balance = await getBalance(addr, env);
  const overrides = await buildTxOverrides(env);
  const decision = computeNativeSweep(balance, overrides.maxFeePerGas, cfg.minSweepThreshold);
  if (!decision.canSend) {
    return { success: false, error: decision.reason, amountMoved: 0n };
  }

  const amountToSend = decision.amountToSend;
  const privateKey = await getPrivateKeyByAddress(addr, env);
  if (!privateKey) return { success: false, error: 'KEY_NOT_FOUND', amountMoved: 0n };

  const walletClient = await walletClientFromKey(privateKey, env);
  const to = await masterAddress(env);
  try {
    const hash = await walletClient.sendTransaction({
      to,
      value: amountToSend,
      ...overrides,
    });
    return { success: true, txHash: hash, amountMoved: amountToSend };
  } catch (error) {
    return { success: false, error: (error as Error).message, amountMoved: 0n };
  }
}

/**
 * Sweep ERC-20 native USDT from a custodial address to the Master Wallet using
 * an EIP-712 Permit (signed by the custodial key) plus transferFrom submitted by
 * the Master Wallet, which pays AVAX gas.
 */
export async function sweepUsdt(
  address: string,
  amount: bigint,
  env: NodeJS.ProcessEnv = process.env
): Promise<SweepResult> {
  const cfg = loadCchainConfig(env);
  if (!cfg.masterWalletPrivateKey) {
    return { success: false, error: 'MASTER_WALLET_NOT_CONFIGURED', amountMoved: 0n };
  }

  const addr = getAddress(address);
  const usdt = getNativeUsdtContract(env);
  const privateKey = await getPrivateKeyByAddress(addr, env);
  if (!privateKey) return { success: false, error: 'KEY_NOT_FOUND', amountMoved: 0n };

  const publicClient = getPublicClient(env);
  const nonce = await publicClient.readContract({
    address: usdt,
    abi: USDT_ABI,
    functionName: 'nonces',
    args: [addr],
  });
  const spender = await masterAddress(env);
  const deadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;

  // EIP-2612 Permit domain for the configured native USDT. Defaults to the
  // Fuji Tether ("USD Tether USDt" / v2) domain; other 6-decimal USD tokens
  // (e.g. Circle "USD Coin") can declare their domain via env.
  const domain = {
    name: process.env.CCHAIN_USDT_PERMIT_NAME || 'USD Tether USDt',
    version: process.env.CCHAIN_USDT_PERMIT_VERSION || '2',
    chainId: cfg.chainId,
    verifyingContract: usdt,
  };
  const types = {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  } as const;
  const message = { owner: addr, spender, value: amount, nonce, deadline };

  try {
    // 1) Custodial key signs the EIP-712 Permit off-chain.
    const custodialClient = await walletClientFromKey(privateKey, env);
    const { signTypedData } = await import('viem/actions');
    const signature = await signTypedData(custodialClient, {
      account: custodialClient.account,
      domain: domain as never,
      types,
      primaryType: 'Permit',
      message: message as never,
    });

    // 2) Split the 65-byte signature into r/s/v; v is 27|28, accepted by Permit.
    const { r, s, v } = hexToSignature(signature);
    const vInt = BigInt(v ?? 27);

    // 3) Master Wallet submits permit(...) then transferFrom(...), paying AVAX gas.
    const masterClient = getMasterWalletClient(env);
    const permitOverrides = await buildTxOverrides(env);
    await masterClient.writeContract({
      address: usdt,
      abi: USDT_ABI,
      functionName: 'permit',
      args: [addr, spender, amount, deadline, vInt, r, s],
      ...permitOverrides,
    } as never);

    const transferOverrides = await buildTxOverrides(env);
    const hash = await masterClient.writeContract({
      address: usdt,
      abi: USDT_ABI,
      functionName: 'transferFrom',
      args: [addr, spender, amount],
      ...transferOverrides,
    } as never);

    return { success: true, txHash: hash, amountMoved: amount };
  } catch (error) {
    return { success: false, error: (error as Error).message, amountMoved: 0n };
  }
}