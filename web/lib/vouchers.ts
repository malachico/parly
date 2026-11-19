export type CreditVoucher = {
  code: string;
  credits: number;
  maxUses: number;
  usedCount: number;
  redeemBefore: string;
  active: boolean;
};
export type VoucherResult = { ok: true; message: string } | { ok: false; error: string };
