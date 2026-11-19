'use client';

import { useState } from 'react';
import { ROOM_TEMPLATES, type RoomTemplate } from '@/lib/roomTemplates';

/** Template buttons for the form `formId`: each sets its goal and its instruction hints, and leaves everything else as typed. */
export function RoomTemplates({ formId }: { formId: string }) {
  const [picked, setPicked] = useState<string>();
  const pick = (t: RoomTemplate) => {
    const fields = (document.getElementById(formId) as HTMLFormElement).elements;
    (fields.namedItem('goal') as HTMLInputElement).value = t.goal;
    for (const name of ['want', 'redLines', 'share'] as const) (fields.namedItem(name) as HTMLTextAreaElement).placeholder = t[name];
    setPicked(t.id);
  };
  return (
    <div role="group" aria-label="Start from a template" className="flex flex-wrap gap-2">
      {ROOM_TEMPLATES.map((t) => (
        <button key={t.id} type="button" aria-pressed={t.id === picked} onClick={() => pick(t)} className={`${t.id === picked ? 'btn-primary' : 'btn'} min-h-10 text-sm`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
