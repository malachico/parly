'use client';

import { useState, useTransition } from 'react';
import { Avatar, type AvatarOf } from '@/components/Avatar';
import { newAvatar } from '@/lib/actions';
import { randomSeed } from '@/lib/avatar';

const COUNT = 8;

/** Your avatar, and a row of fresh faces to pick from; "Show more" deals another row. */
export function AvatarPicker({ me, initial, back }: { me: AvatarOf & { name: string }; initial: string[]; back?: string }) {
  const [options, setOptions] = useState(initial);
  const [picked, setPicked] = useState<string>();
  const [pending, start] = useTransition();
  const pick = (seed: string) => {
    setPicked(seed);
    start(() => newAvatar(seed, back));
  };
  return (
    <section className="card flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <Avatar who={{ ...me, avatar: picked ?? me.avatar }} className="size-16" label={`${me.name}'s avatar`} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="font-medium">Your avatar</span>
          <span className="text-[13px] text-[var(--muted)]">{pending ? 'Saving…' : 'Not you? Pick another face below. People in your workspaces see it next to your name.'}</span>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8" role="group" aria-label="Pick a new avatar">
        {options.map((seed, i) => (
          <button
            key={seed}
            type="button"
            disabled={pending}
            onClick={() => pick(seed)}
            aria-label={`Avatar option ${i + 1}`}
            aria-pressed={picked === seed}
            className={`flex aspect-square items-center justify-center rounded-xl p-1.5 hover:bg-[var(--subtle)] disabled:opacity-60 ${picked === seed ? 'bg-[var(--accent-soft)] ring-2 ring-[var(--accent)]' : ''}`}
          >
            <Avatar who={{ ...me, avatar: seed }} className="size-full" presence={false} />
          </button>
        ))}
      </div>
      <button type="button" className="btn-ghost self-start" disabled={pending} onClick={() => setOptions(Array.from({ length: COUNT }, randomSeed))}>
        Show more
      </button>
    </section>
  );
}
