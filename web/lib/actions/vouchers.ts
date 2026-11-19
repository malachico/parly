'use server';

import { revalidatePath } from 'next/cache';
import { hub, HubError } from '../hub';
import { field } from './helpers';
import type { VoucherResult } from '../vouchers';

export async function createCreditVoucher(form: FormData): Promise<VoucherResult> {
  try {
    await hub('/admin/vouchers', { method: 'POST', body: { code: field(form, 'code'), credits: Number(field(form, 'credits')), maxUses: Number(field(form, 'maxUses')), validUntil: field(form, 'validUntil') } });
    revalidatePath('/admin/vouchers');
    return { ok: true, message: 'Voucher created.' };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    return { ok: false, error: 'Unable to create the voucher. Please try again.' };
  }
}

export async function disableCreditVoucher(code: string): Promise<VoucherResult> {
  try {
    await hub(`/admin/vouchers/${encodeURIComponent(code)}`, { method: 'PATCH', body: { active: false } });
    revalidatePath('/admin/vouchers');
    return { ok: true, message: 'Voucher disabled.' };
  } catch (err) {
    return { ok: false, error: err instanceof HubError ? err.message : 'Unable to disable the voucher. Please try again.' };
  }
}

export async function redeemCreditVoucher(form: FormData): Promise<VoucherResult> {
  try {
    const result = await hub<{ creditsAdded: number }>('/me/vouchers/redeem', { method: 'POST', body: { code: field(form, 'code') } });
    revalidatePath('/billing');
    return { ok: true, message: `+${result.creditsAdded.toLocaleString()} credits added to your balance.` };
  } catch (err) {
    return { ok: false, error: err instanceof HubError ? err.message : 'Unable to apply the voucher. Please try again.' };
  }
}
