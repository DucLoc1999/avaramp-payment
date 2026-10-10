import { privateKeyToAccount } from 'viem/accounts';
import {
  keccak256,
  serializeTransaction,
  toHex,
  type Account,
  type Hex,
  type TransactionSerializable,
} from 'viem';
import { publicKeyToAddress } from 'viem/utils';
import { loadCchainConfig } from '../config/cchain';
import { getKmsPublicKeyCompressed, signTxHash } from './gcpKmsService';
import { decompressSecp256k1PublicKey } from '../utils/secp256k1';

/**
 * Sign an EIP-1559 transaction with the GCP KMS secp256k1 key. GCP KMS returns a
 * DER ECDSA signature; `signTxHash` normalizes to low-`s` and resolves the
 * recovery id, yielding `r‖s‖v` with v ∈ {0,1} suitable for `yParity`.
 */
async function signTransactionWithKms(transaction: TransactionSerializable): Promise<Hex> {
  const unsigned = serializeTransaction(transaction);
  const digest = keccak256(unsigned);
  const signature = await signTxHash(Buffer.from(digest.slice(2), 'hex'));
  return serializeTransaction(transaction, {
    r: toHex(signature.subarray(0, 32)),
    s: toHex(signature.subarray(32, 64)),
    yParity: signature[64],
  });
}

/**
 * Resolve the C-Chain payout account. Precedence:
 *  1. `CCHAIN_PAYOUT_WALLET_PRIVATE_KEY` — explicit payout key.
 *  2. `MASTER_WALLET_PRIVATE_KEY` when `CCHAIN_PAYOUT_USE_MASTER_WALLET=true` —
 *     the "one wallet" deployment where sell sweeps and buy payouts share a key.
 *  3. The GCP KMS secp256k1 key (legacy).
 */
export async function getPayoutAccount(env: NodeJS.ProcessEnv = process.env): Promise<Account> {
  const cfg = loadCchainConfig(env);
  if (cfg.payoutWalletPrivateKey) {
    return privateKeyToAccount(cfg.payoutWalletPrivateKey as `0x${string}`);
  }
  if (cfg.payoutUseMasterWallet && cfg.masterWalletPrivateKey) {
    return privateKeyToAccount(cfg.masterWalletPrivateKey as `0x${string}`);
  }
  const compressed = await getKmsPublicKeyCompressed();
  const address = publicKeyToAddress(decompressSecp256k1PublicKey(compressed));
  return {
    address,
    type: 'local',
    signTransaction: (transaction: TransactionSerializable) => signTransactionWithKms(transaction),
  } as unknown as Account;
}

/** The resolved C-Chain payout wallet `0x` address. */
export async function getPayoutAddress(env: NodeJS.ProcessEnv = process.env): Promise<`0x${string}`> {
  const account = await getPayoutAccount(env);
  return account.address;
}
