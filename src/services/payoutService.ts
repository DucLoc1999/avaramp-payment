import { PayOS, PayoutRequest as PayOSPayoutRequest } from '@payos/node';
import { getBinById } from '../config/banks';

export interface BalanceResult {
  success: boolean;
  balance?: number;
  availableBalance?: number;
  error?: string;
}

export interface PayoutRequest {
  orderId: number;
  amount: number;
  bankId: string;
  bankAccountName: string;
  bankAccountNo: string;
  description?: string;
  /**
   * Stable idempotency key handed to PayOS. Callers MUST pass a value that is
   * constant across retries (e.g. `payout_<orderId>`); the default below is
   * stable per order, but a timestamped value would let a retry pay twice.
   */
  referenceId?: string;
}

export interface PayoutResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

let payOSInstance: PayOS | null = null;

function getPayOS(): PayOS {
  if (!payOSInstance) {
    payOSInstance = new PayOS({
      clientId: process.env.PAYOS_CLIENT_ID!,
      apiKey: process.env.PAYOS_API_KEY!,
      checksumKey: process.env.PAYOS_CHECKSUM_KEY!,
    });
  }
  return payOSInstance;
}

export async function getAccountBalance(forceStub = false): Promise<BalanceResult> {
  if (process.env.PAYOUT_MODE === 'stub' || forceStub) {
    console.log(`[PayoutService] STUB getAccountBalance called`);
    return {
      success: true,
      balance: 50000000,
      availableBalance: 45000000,
    };
  }

  getPayOS();

  try {
    console.log(`[PayoutService] PAYOS fetching account balance via Native Fetch...`);

    const response = await fetch('https://api-merchant.payos.vn/v1/payouts-account/balance', {
      method: 'GET',
      headers: {
        'x-client-id': process.env.PAYOS_CLIENT_ID!,
        'x-api-key': process.env.PAYOS_API_KEY!,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = (await response.json()) as any;

    if (result.code === '00') {
      console.log(`[PayoutService] PAYOS fetch balance success`);
      const rawBalance = result.data?.balance;
      const rawAvailable = result.data?.availableBalance;
      return {
        success: true,
        balance: typeof rawBalance === 'number' ? rawBalance : Number(rawBalance) || 0,
        availableBalance: rawAvailable != null
          ? (typeof rawAvailable === 'number' ? rawAvailable : Number(rawAvailable) || 0)
          : (typeof rawBalance === 'number' ? rawBalance : Number(rawBalance) || 0),
      };
    } else {
      throw new Error(result.desc || 'Unknown error from PayOS');
    }
  } catch (err) {
    console.error(`[PayoutService] PAYOS fetch balance error:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function executePayout(req: PayoutRequest, forceStub = false): Promise<PayoutResult> {
  if (process.env.PAYOUT_MODE === 'stub' || forceStub) {
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`[PayoutService] STUB payout for order ${req.orderId}: ${req.amount} VND to ${req.bankAccountNo}`);
    return { success: true, transactionId: `stub-${Date.now()}` };
  }

  const payOS = getPayOS();
  try {
    const bin = getBinById(Number(req.bankId)) || req.bankId;
    const referenceId = req.referenceId ?? `payout_${req.orderId}`;
    console.log(`[PayoutService] PAYOS payout: bin=${bin}, account=${req.bankAccountNo}, amount=${req.amount} VND, ref=${referenceId}`);
    const payout = await payOS.payouts.create({
      referenceId,
      amount: req.amount,
      description: req.description || `Withdrawal ${req.orderId}`,
      toBin: bin,
      toAccountNumber: req.bankAccountNo,
    } as PayOSPayoutRequest);
    console.log(`[PayoutService] PAYOS payout created: ${payout.id} for order ${req.orderId}, approvalState: ${payout.approvalState}`);
    return { success: true, transactionId: payout.id };
  } catch (err) {
    console.error(`[PayoutService] PAYOS error for order ${req.orderId}:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}