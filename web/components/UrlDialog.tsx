'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useParamHref } from '@/components/FindDialog';
import { Dialog } from '@/components/Modal';

/**
 * A dialog the server renders while the URL has ?<param>=, so links open it and the phone's back
 * button closes it. Closing drops the param.
 */
export function UrlDialog({ param, title, children }: { param: string; title: string; children: React.ReactNode }) {
  const params = useSearchParams();
  const router = useRouter();
  const href = useParamHref();
  return (
    <Dialog open={params.has(param)} onClose={() => router.replace(href(param, undefined), { scroll: false })} title={title} wide>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </Dialog>
  );
}
