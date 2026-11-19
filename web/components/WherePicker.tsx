'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Avatar } from '@/components/Avatar';
import type { Agent } from '@/lib/hub';

type WhereChannel = { id: string; name: string; ws: string };

/**
 * Searchable autocomplete picker for a trigger's destination (`channelId`):
 * either the agent's DM (`""`, when `dmLabel` is given) or a `#channel (workspace)`.
 */
export function WherePicker({ label, dmLabel, channels }: { label: string; dmLabel?: string; channels: WhereChannel[] }) {
  const listId = useId();
  const options = useMemo(
    () => [...(dmLabel ? [{ id: '', label: dmLabel }] : []), ...channels.map((c) => ({ id: c.id, label: `#${c.name} (${c.ws})` }))],
    [dmLabel, channels],
  );

  const [selectedId, setSelectedId] = useState<string>(dmLabel ? '' : (channels[0]?.id ?? ''));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const prevHasDm = useRef(Boolean(dmLabel));

  // When switching between an agent (DM allowed) and "No agent" (channel only), reset to the appropriate default.
  useEffect(() => {
    const hasDm = Boolean(dmLabel);
    if (hasDm !== prevHasDm.current) {
      prevHasDm.current = hasDm;
      if (!hasDm && selectedId === '') setSelectedId(channels[0]?.id ?? '');
      else if (hasDm && selectedId === (channels[0]?.id ?? '')) setSelectedId('');
    } else if (!hasDm && selectedId === '' && channels[0]?.id) {
      setSelectedId(channels[0].id);
    }
  }, [dmLabel, channels, selectedId]);

  const selectedOption = options.find((o) => o.id === selectedId) ?? options[0];
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options), [options, q]);

  const pick = (id: string) => {
    setSelectedId(id);
    setOpen(false);
    setQuery('');
    setActive(0);
  };

  return (
    <div className="block space-y-1.5">
      <label htmlFor={`${listId}-input`} className="block text-sm font-medium">
        {label}
      </label>
      <input type="hidden" name="channelId" value={selectedOption?.id ?? ''} />
      <div className="relative">
        <input
          id={`${listId}-input`}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && matches[active] ? `${listId}-opt-${active}` : undefined}
          value={open ? query : (selectedOption?.label ?? '')}
          placeholder={selectedOption?.label ?? (dmLabel || 'Search channels…')}
          disabled={options.length === 0}
          autoComplete="off"
          onFocus={() => {
            setOpen(true);
            setQuery('');
            const idx = options.findIndex((o) => o.id === (selectedOption?.id ?? ''));
            setActive(idx >= 0 ? idx : 0);
          }}
          onClick={() => {
            if (!open) {
              setOpen(true);
              setQuery('');
            }
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onBlur={() => {
            setOpen(false);
            setQuery('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (!open) {
                setOpen(true);
                setQuery('');
                return;
              }
              if (matches.length > 0) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if (open && (e.key === 'Enter' || e.key === 'Tab')) {
              if (matches[active]) {
                if (e.key === 'Enter') e.preventDefault();
                pick(matches[active].id);
              }
              return;
            }
            if (open && e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              setQuery('');
            }
          }}
          className="input w-full pr-8"
        />
        <span aria-hidden className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-[var(--muted)]">
          ▾
        </span>
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            className="absolute top-full left-0 z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-lg"
          >
            {matches.length === 0 ? (
              <li className="px-3 py-2 text-sm text-[var(--muted)]">No matching destination.</li>
            ) : (
              matches.map((o, i) => (
                <li
                  key={o.id || '__dm__'}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  aria-selected={o.id === (selectedOption?.id ?? '')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o.id);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`cursor-pointer truncate px-3 py-2 text-sm ${i === active ? 'bg-[var(--subtle)] font-medium' : ''}`}
                >
                  {o.label}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Interactive listener form fields on `triggers/[id]`: picking "No agent" hides the DM option & task field
 * and resets "Where?" to a channel.
 */
export function ListenerFormFields({ matches, channels }: { matches: Pick<Agent, 'id' | 'name' | 'avatar'>[]; channels: WhereChannel[] }) {
  const [agentId, setAgentId] = useState<string>(matches[0]?.id ?? '');
  const matchKey = matches.map((m) => m.id).join(',');

  // biome-ignore lint/correctness/useExhaustiveDependencies: matchKey is the stable stringified match-id list that stands in for the matches array (a fresh array every render); re-seed the default agent only when the ids actually change
  useEffect(() => {
    setAgentId(matches[0]?.id ?? '');
  }, [matchKey]); // matchKey tracks matches ids

  const hasAgent = Boolean(agentId);

  return (
    <>
      <fieldset className="space-y-1 text-sm">
        <legend className="sr-only">Agent</legend>
        {matches.map((a) => (
          <label key={a.id} className="flex items-center gap-2">
            <input type="radio" name="agentId" value={a.id} checked={agentId === a.id} onChange={() => setAgentId(a.id)} />
            <Avatar who={a} className="size-6" />
            {a.name}
          </label>
        ))}
        <label className="flex items-center gap-2 text-[var(--muted)]">
          <input type="radio" name="agentId" value="" checked={agentId === ''} onChange={() => setAgentId('')} />
          {matches.length ? 'No agent: just post the event in a channel' : 'No agent yet: type a name above, or just post the event in a channel'}
        </label>
      </fieldset>
      <WherePicker label="2. Where?" dmLabel={hasAgent ? 'Its DM with you' : undefined} channels={channels} />
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">
          3. Only some events? <span className="font-normal text-[var(--muted)]">(optional)</span>
        </span>
        <input name="contains" placeholder="e.g. billing: only events that mention it" className="input w-full" />
      </label>
      {hasAgent && (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">
            4. What should the agent do? <span className="font-normal text-[var(--muted)]">(optional)</span>
          </span>
          <input name="task" placeholder="e.g. summarize the PR and review it" className="input w-full" />
        </label>
      )}
    </>
  );
}

