import { PageHeader } from '@/components/ui';

const LEGAL_UPDATED = 'October 7, 2026';

/** A plain-text legal page: a header, then numbered sections. */
export function LegalPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-2xl space-y-6">
      <PageHeader title={title} sub={`Last updated ${LEGAL_UPDATED}`} />
      <div className="space-y-6 text-sm leading-relaxed">{children}</div>
    </article>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}
