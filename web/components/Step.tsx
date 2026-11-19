/** A numbered step of setup instructions: a title, an optional hint, then what to do. */
export function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--fg)] text-xs font-semibold text-[var(--bg)]">{n}</span>
        <span className="font-medium">{title}</span>
      </div>
      {hint && <p className="muted">{hint}</p>}
      {children}
    </div>
  );
}
