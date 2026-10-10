/** Partner policy shared by order creation and the sell payout pipeline. */

/** Partner name whose withdrawals skip VND payout and VND liquidity reservation. */
export const NO_PAYOUT_PARTNER_NAME = 'tx-bot';

export function isNoPayoutPartnerName(name: string | undefined | null): boolean {
  return name === NO_PAYOUT_PARTNER_NAME;
}
