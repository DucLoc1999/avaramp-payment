// AvaRamp partner-facing order API contract.
// NOTE: the JSON shape of these payloads is the external partner contract and
// has been stable since the legacy "usdt247" product era — field names and
// structure must NOT change (only these internal type identifiers were renamed).

export interface AvaRampTimestamp {
  seconds: number;
  nanos: number;
}

export interface AvaRampBankInfo {
  bankAccountName?: string;
  bankAccountNumber?: string;
  bankId?: string;
  bankName?: string;
  transferContent?: string;
  vaAmount?: number;
}

export interface AvaRampResponseBody {
  bank_id?: number;
  full_name?: string;
  account_type?: number;
  account_number?: string;
  amount?: string;
  qr_code?: string;
  qr_link?: string;
  qr_data?: string;
  bankInfo?: AvaRampBankInfo;
  transferContent?: string;
  vaAmount?: number;
}

export interface AvaRampPayData {
  address?: string;
  amount?: string;
  chain_id?: string;
  token_address?: string;
  asset_code?: string;
  qr_code?: string;
  qr_link?: string;
}

export interface AvaRampPaymentInfo {
  bank_id: string;
  full_name: string;
  account_type: number;
  account_number: string;
}

export interface AvaRampOrder {
  id: string;
  user_id: string;
  order_type: 'buy' | 'sell';
  code: string;
  provider: string;
  callback: string;
  amount: number;
  currency: string;
  chain?: string;
  rate: number;
  token_address: string;
  asset_code: string;
  recipient: string;
  chain_id: number;
  partner_id: string | null;
  state: number;
  processing_state: number;
  body: AvaRampResponseBody | null;
  pay_data: AvaRampPayData | null;
  payment_info: AvaRampPaymentInfo | null;
  expired_at: AvaRampTimestamp;
  created_at: AvaRampTimestamp;
  updated_at: AvaRampTimestamp;
  net_vnd: number;
  total_fee_vnd: number;
  transaction_hash?: string | null;
}
