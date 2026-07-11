export interface PayoutResponse {
  id: string;
  split_address: string;
  recipient: string;
  token: string;
  amount: string;
  usd_value: string | null;
  tx_hash: string | null;
  distributed_at: string;
}
