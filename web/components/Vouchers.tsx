'use client';

import { useState, useTransition } from 'react';
import type { VoucherResult } from '@/lib/vouchers';

function Result({ result }: { result?: VoucherResult }) {
  return result ? <p role={result.ok ? 'status' : 'alert'} className={`text-sm ${result.ok ? 'text-[var(--ok-fg)]' : 'text-[var(--bad-fg)]'}`}>{result.ok ? result.message : result.error}</p> : null;
}

export function CreateVoucherForm({ action }: { action: (form: FormData) => Promise<VoucherResult> }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<VoucherResult>();
  const [credits, setCredits] = useState('');
  return <form className="card space-y-4" onSubmit={(e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    start(async () => { try { const res = await action(data); setResult(res); if (res.ok) { form.reset(); setCredits(''); } } catch { setResult({ ok: false, error: 'Request interrupted. Please try again.' }); } });
  }}>
    <h2 className="font-semibold">Create voucher</h2>
    <fieldset disabled={pending} className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm"><span>Code</span><input className="input w-full" name="code" required minLength={2} maxLength={40} pattern="[A-Za-z0-9_-]{2,40}" placeholder="yay2026" autoCapitalize="none" spellCheck={false} /></label>
      <label className="space-y-1 text-sm"><span>Credits</span><input className="input w-full" name="credits" aria-label="Credits" aria-describedby="voucher-credit-value" type="number" min="1" step="1" required value={credits} onChange={(e) => setCredits(e.target.value)} /><span id="voucher-credit-value" className="block text-xs text-[var(--muted)]">{Number(credits) > 0 ? `$${(Number(credits) / 100).toFixed(2)} of usage` : '100 credits = $1 of usage'}</span></label>
      <label className="space-y-1 text-sm"><span>Maximum unique users</span><input className="input w-full" name="maxUses" type="number" min="1" step="1" required /></label>
      <label className="space-y-1 text-sm"><span>Redeem by (end of day UTC)</span><input className="input w-full min-w-0" name="validUntil" type="date" required /></label>
    </fieldset>
    <p className="text-xs text-[var(--muted)]">Once per account. Granted credits are spent after the monthly allowance and remain until used. Amount, limit and deadline cannot be edited after creation.</p>
    <Result result={result} />
    <button type="submit" disabled={pending} className="btn-primary">{pending ? 'Creating…' : 'Create voucher'}</button>
  </form>;
}

export function DisableVoucherButton({ action }: { action: () => Promise<VoucherResult> }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<VoucherResult>();
  return <div className="space-y-2"><button type="button" className="btn-ghost" disabled={pending || result?.ok} onClick={() => start(async () => { try { setResult(await action()); } catch { setResult({ ok: false, error: 'Request interrupted. Please try again.' }); } })}>{pending ? 'Disabling…' : result?.ok ? 'Disabled' : 'Disable'}</button><Result result={result} /></div>;
}

export function RedeemVoucherForm({ action }: { action: (form: FormData) => Promise<VoucherResult> }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<VoucherResult>();
  return <form className="card space-y-3" onSubmit={(e) => {
    e.preventDefault(); const form = e.currentTarget; const data = new FormData(form);
    start(async () => { try { const res = await action(data); setResult(res); if (res.ok) form.reset(); } catch { setResult({ ok: false, error: 'Request interrupted. Please try again.' }); } });
  }}>
    <h2 className="font-semibold">Redeem a voucher</h2>
    <label className="block text-sm" htmlFor="voucher-code">Voucher code</label>
    <div className="flex gap-2"><input id="voucher-code" disabled={pending} className="input min-w-0 flex-1" name="code" required minLength={2} maxLength={40} placeholder="Enter code" autoCapitalize="none" spellCheck={false} /><button type="submit" disabled={pending} className="btn-primary shrink-0">{pending ? 'Applying…' : 'Apply'}</button></div>
    <Result result={result} />
    <p className="text-xs text-[var(--muted)]">Each voucher can be used once per account. Added credits remain until used.</p>
  </form>;
}
