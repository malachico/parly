'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, type AvatarOf } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { QUOTE_REPLY_EVENT, QuotePreview, type Quote } from '@/components/MessageQuote';
import { uploadFile } from '@/lib/upload';
import { sendInConversation } from '@/lib/actions';
import type { MessageView } from '@/lib/hub';
import { formatSize } from '@/lib/labels';
import { useLiveMessages } from '@/lib/live';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type RenderedMessageRef = Pick<MessageView, 'id' | 'seq' | 'fromId' | 'text' | 'replyTo'>;

// Stable defaults, so the memos below don't see a new empty array every render.
const NO_STARTERS: string[] = [];
const NO_MEMBERS: { id: string; name: string }[] = [];
const NO_MESSAGES: RenderedMessageRef[] = [];

export type OptimisticItem = {
  replyTo?: Quote;
  clientId: string;
  /** Conversation or thread draftKey where this send originated, so it never leaks into another conversation/thread. */
  draftKey?: string;
  /** Text shown in the optimistic bubble (body text or attachment label). */
  display: string;
  /** Trimmed text sent to the hub, used to match the live copy that can arrive before the POST returns. */
  rawText: string;
  files?: string[];
  /** Highest rendered seq in the conversation when the send started. */
  baselineSeq: number;
  /** True while the POST request is in flight; cleared as soon as the hub acknowledges it. */
  sending: boolean;
  /** Populated once the hub POST returns the created message. */
  serverId?: string;
  serverSeq?: number;
};

/**
 * Filters out optimistic bubbles that belong to a different `activeDraftKey` or whose real server message has arrived
 * in `rendered` (from the live stream, possibly while the POST is still in flight, or from the server render).
 * Consumes matched rendered messages 1-for-1 so two identical rapid sends don't both collapse on the first arrival.
 */
export function pruneOptimisticMessages(
  queue: OptimisticItem[],
  rendered: RenderedMessageRef[],
  meId?: string,
  activeDraftKey?: string,
): OptimisticItem[] {
  const scoped =
    activeDraftKey !== undefined
      ? queue.filter((item) => item.draftKey === undefined || item.draftKey === activeDraftKey)
      : queue;
  if (scoped.length === 0 || rendered.length === 0) return scoped;
  const consumed = new Set<string>();
  return scoped.filter((item) => {
    if (item.serverId) {
      const byId = rendered.find((m) => !consumed.has(m.id) && m.id === item.serverId);
      if (byId) {
        consumed.add(byId.id);
        return false;
      }
    }
    if (item.serverSeq !== undefined) {
      const bySeq = rendered.find((m) => !consumed.has(m.id) && m.seq === item.serverSeq && (!meId || m.fromId === meId));
      if (bySeq) {
        consumed.add(bySeq.id);
        return false;
      }
    }
    const byContentAfterBaseline = rendered.find(
      (m) =>
        !consumed.has(m.id) &&
        m.seq > item.baselineSeq &&
        (!meId || m.fromId === meId) &&
        (m.text ?? '').trim() === item.rawText &&
        m.replyTo?.id === item.replyTo?.id,
    );
    if (byContentAfterBaseline) {
      consumed.add(byContentAfterBaseline.id);
      return false;
    }
    return true;
  });
}

type Props = {
  /** Draft storage key; one draft per conversation. */
  draftKey: string;
  /** The workspace the conversation is open in (for scoped message revalidation). */
  workspaceId: string;
  to?: string;
  channelId?: string;
  /** Channel only: reply in the thread of this post. */
  thread?: string;
  placeholder: string;
  /** Focus the box on load (a conversation with no messages yet). */
  autoFocus?: boolean;
  /** Channel only: example first posts, one tap fills the box (shown while it's empty). */
  starters?: string[];
  /** Channel only: who "@" can mention (the hub matches "@<display name>"). */
  members?: { id: string; name: string }[];
  /** Who is sending, for the avatar on the message while it sends. */
  me?: AvatarOf;
  /** Id of the element at the end of the thread where the sending message shows, as if already sent. */
  outbox?: string;
  /** Messages currently rendered in the timeline/thread, used to deduplicate optimistic bubbles in place. */
  renderedMessages?: RenderedMessageRef[];
  /** The hub's id for this conversation ("dm:…", "channel:…"): messages that arrive live there count as rendered too. */
  liveConversation?: string;
  /** Called once the server acknowledges a sent message so thread caches can update their own entry immediately. */
  onSent?: (message: MessageView) => void;
};

/** The "@partial" right before the caret, if the caret is in one (an "@" not glued to a word, like in an email). */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|[^\p{L}\p{N}_.])@([^\s@]{0,40})$/u.exec(text.slice(0, caret));
  return m ? { start: caret - m[1]!.length - 1, query: m[1]!.toLowerCase() } : null;
}

/** The hub's limit (MAX_FILE_MB); checked here too so a big file fails before uploading. */
const MAX_FILES = 10;

type Attachment = {
  key: string;
  name: string;
  size: number;
  status: 'uploading' | 'ready' | 'failed';
  id?: string;
  error?: string;
  /** Images only: a local object URL for the thumbnail (revoked when the chip goes away). */
  preview?: string;
};

/** Uploads one file straight to storage via a signed URL; returns the hub's file id. */

/**
 * The one message box for a thread. Enter sends (return is a newline on touch screens); Shift+Enter is a newline. The draft lives
 * in localStorage, so polling, navigation and reloads don't lose it. A failed send keeps the
 * text and offers Retry; text typed while a send is in flight stays.
 */
export function Composer({ draftKey, workspaceId, to, channelId, thread, placeholder, autoFocus, starters = NO_STARTERS, members = NO_MEMBERS, me, outbox, renderedMessages: fromPage = NO_MESSAGES, liveConversation, onSent }: Props) {
  const renderedMessages = useLiveMessages(liveConversation, fromPage);
  const storage = `draft:${draftKey}`;
  const [text, setText] = useState('');
  const [quote, setQuote] = useState<Quote | undefined>(undefined);
  const quoteRef = useRef(quote);
  quoteRef.current = quote;
  // Optimistic messages shown at the bottom of the thread until the real message arrives in `renderedMessages`.
  const [optimistic, setOptimistic] = useState<OptimisticItem[]>([]);
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;
  const [error, setError] = useState<string | null>(null);
  const [failedPayload, setFailedPayload] = useState<{ body: string; attachments: Attachment[]; quote?: Quote } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setQuote(undefined);
    const select = (event: Event) => {
      const detail = (event as CustomEvent<{ quoteKey: string; quote: Quote }>).detail;
      if (detail.quoteKey !== draftKey) return;
      setQuote(detail.quote);
      box.current?.focus();
    };
    window.addEventListener(QUOTE_REPLY_EVENT, select);
    return () => window.removeEventListener(QUOTE_REPLY_EVENT, select);
  }, [draftKey]);

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const uploading = attachments.some((a) => a.status === 'uploading');
  const ready = attachments.filter((a) => a.status === 'ready');
  // Every preview URL made, so the ones still on screen are freed on unmount.
  const previews = useRef(new Set<string>());
  useEffect(() => () => previews.current.forEach((u) => URL.revokeObjectURL(u)), []);

  function attach(files: FileList | File[]) {
    const room = Math.max(0, MAX_FILES - attachments.length);
    const list = Array.from(files);
    if (list.length > room) {
      setFailedPayload(null);
      setError(`Up to ${MAX_FILES} files per message; ${list.length - room === 1 ? '1 file was' : `${list.length - room} files were`} left out.`);
    }
    for (const file of list.slice(0, room)) {
      const key = `${file.name}:${file.size}:${Math.random()}`;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.add(preview);
      setAttachments((cur) => [...cur, { key, name: file.name, size: file.size, status: 'uploading', preview }]);
      uploadFile(file).then(
        (id) => setAttachments((cur) => cur.map((a) => (a.key === key ? { ...a, status: 'ready', id } : a))),
        (err: Error) => setAttachments((cur) => cur.map((a) => (a.key === key ? { ...a, status: 'failed', error: err.message } : a))),
      );
    }
  }
  function forget(a: Attachment) {
    if (!a.preview) return;
    URL.revokeObjectURL(a.preview);
    previews.current.delete(a.preview);
  }

  function remove(a: Attachment) {
    forget(a);
    setAttachments((cur) => cur.filter((x) => x.key !== a.key));
  }

  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  // ponytail: prefix-then-substring match over the member list; fine for channels of tens.
  const matches = useMemo(
    () =>
      mention
        ? members
            .filter((m) => m.name.toLowerCase().includes(mention.query))
            .sort((a, b) => Number(!a.name.toLowerCase().startsWith(mention.query)) - Number(!b.name.toLowerCase().startsWith(mention.query)))
            .slice(0, 6)
        : [],
    [mention, members],
  );
  const picking = matches.length > 0;

  function track(el: HTMLTextAreaElement) {
    const next = members.length ? mentionAt(el.value, el.selectionStart) : null;
    setMention(next);
    if (next?.query !== mention?.query) setActive(0);
  }

  function pick(name: string) {
    const el = box.current;
    if (!el || !mention) return;
    const caret = el.selectionStart;
    const inserted = `@${name} `;
    setText(text.slice(0, mention.start) + inserted + text.slice(caret));
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(mention.start + inserted.length, mention.start + inserted.length);
    });
  }

  // Load the saved draft once per storage key; only after that draft settles start saving, so the initial empty state never overwrites it.
  const loadedFor = useRef<string | null>(null);
  const loadedText = useRef('');
  // Saving is debounced (~500ms); the pending save is flushed when the key changes, on unmount and when the page hides.
  const pendingDraft = useRef<{ key: string; text: string } | null>(null);
  const flushDraft = useRef(() => {
    const p = pendingDraft.current;
    pendingDraft.current = null;
    if (!p) return;
    try {
      if (p.text) localStorage.setItem(p.key, p.text);
      else localStorage.removeItem(p.key);
    } catch {}
  }).current;
  useEffect(() => {
    window.addEventListener('pagehide', flushDraft);
    return () => window.removeEventListener('pagehide', flushDraft);
  }, [flushDraft]);
  useEffect(() => {
    loadedFor.current = null;
    let initial = '';
    try {
      initial = localStorage.getItem(storage) ?? '';
    } catch {}
    loadedText.current = initial;
    setText(initial);
    return flushDraft;
  }, [storage, flushDraft]);
  useEffect(() => {
    if (loadedFor.current !== storage) {
      if (text !== loadedText.current) return;
      loadedFor.current = storage;
      return;
    }
    pendingDraft.current = { key: storage, text };
    const timer = setTimeout(flushDraft, 500);
    return () => clearTimeout(timer);
  }, [storage, text, flushDraft]);

  // Grow with the text from one line up to ten (less on a short screen, so the thread stays visible), then it scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the re-run trigger, not read here — re-measure the textarea height whenever the text changes
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    // Hidden (the main column while a thread is open on a phone) measures 0: leave it at its natural height.
    if (el.scrollHeight) el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  // Deduplicate during render so there is never a frame where both the server message and the optimistic bubble show.
  const visibleOptimistic = useMemo(
    () => pruneOptimisticMessages(optimistic, renderedMessages, me?.id, draftKey),
    [optimistic, renderedMessages, me?.id, draftKey],
  );
  useEffect(() => {
    if (visibleOptimistic.length !== optimistic.length) {
      const keepIds = new Set(visibleOptimistic.map((o) => o.clientId));
      setOptimistic((cur) => (cur.every((o) => keepIds.has(o.clientId)) ? cur : cur.filter((o) => keepIds.has(o.clientId))));
    }
  }, [visibleOptimistic, optimistic]);

  // The thread's slot for the sending message (found after mount; it's in the server-rendered page).
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(outbox ? document.getElementById(outbox) : null), [outbox]);
  // Show it at the bottom of the thread, like a new message arriving.
  useIsoLayoutEffect(() => {
    if (!visibleOptimistic.length || !slot) return;
    slot.scrollIntoView({ block: 'end' });
  }, [visibleOptimistic.length, slot]);

  function send(retry?: { body: string; attachments: Attachment[]; quote?: Quote }) {
    const body = retry ? retry.body : text;
    const sentQuote = retry ? retry.quote : quote;
    const sentAttachments = retry ? retry.attachments : ready;
    const trimmed = body.trim();
    if ((!trimmed && !sentAttachments.length) || uploading) return;
    const files = sentAttachments.map((a) => a.id!);
    const clientId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const baselineSeq = Math.max(
      renderedMessages.at(-1)?.seq ?? 0,
      ...optimistic.map((o) => o.serverSeq ?? o.baselineSeq),
    );
    const display = body || sentAttachments.map((a) => `📎 ${a.name}`).join('\n');

    setError(null);
    setFailedPayload(null);
    setOptimistic((cur) => [...cur, { clientId, draftKey, display, replyTo: sentQuote, rawText: trimmed, files, baselineSeq, sending: true }]);
    // Clear the input and ready attachments immediately so typing is never blocked on the server round-trip.
    if (!retry || text === body) {
      setText('');
      // Drop a not-yet-written save of the sent text, so it can't land after the draft is cleared.
      pendingDraft.current = null;
      try {
        localStorage.removeItem(storage);
      } catch {}
    }
    const sentKeys = new Set(sentAttachments.map((a) => a.key));
    setAttachments((cur) => cur.filter((a) => !sentKeys.has(a.key)));
    box.current?.focus();

    void (async () => {
      try {
        const res = await sendInConversation({ workspaceId, to, channelId, text: body, thread, files, replyTo: sentQuote?.id });
        if (!res.ok) {
          setOptimistic((cur) => cur.filter((o) => o.clientId !== clientId));
          setError(res.error);
          setFailedPayload({ body, attachments: sentAttachments, quote: sentQuote });
          setText((cur) => (cur ? cur : body));
          setAttachments((cur) => [...sentAttachments.filter((sa) => !cur.some((x) => x.key === sa.key)), ...cur]);
          return;
        }
        if (quoteRef.current?.id === sentQuote?.id) setQuote(undefined);
        sentAttachments.forEach(forget);
        if (res.message) onSentRef.current?.(res.message);
        setOptimistic((cur) =>
          cur.map((o) =>
            o.clientId === clientId
              ? { ...o, sending: false, ...(res.message ? { serverId: res.message.id, serverSeq: res.message.seq } : {}) }
              : o,
          ),
        );
      } catch (err) {
        setOptimistic((cur) => cur.filter((o) => o.clientId !== clientId));
        setError(err instanceof Error ? err.message : 'Failed to send message');
        setFailedPayload({ body, attachments: sentAttachments, quote: sentQuote });
        setText((cur) => (cur ? cur : body));
        setAttachments((cur) => [...sentAttachments.filter((sa) => !cur.some((x) => x.key === sa.key)), ...cur]);
      }
    })();
  }

  return (
    <div className="@container flex flex-col gap-2">
      {visibleOptimistic.length > 0 && slot && createPortal(<SendingList items={visibleOptimistic} me={me} />, slot)}
      {visibleOptimistic.length > 0 && !slot && <SendingList items={visibleOptimistic} me={me} />}
      {error && (
        <p role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
          {failedPayload ? `Not sent: ${error}` : error}
          {failedPayload ? (
            <button type="button" className="font-medium underline" onClick={() => send(failedPayload)}>
              Retry
            </button>
          ) : (
            <button type="button" aria-label="Dismiss" className="ms-auto px-1" onClick={() => setError(null)}>
              ×
            </button>
          )}
        </p>
      )}
      {starters.length > 0 && !thread && !text.trim() && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Examples to start with">
          <span className="text-xs text-[var(--muted)]">Try:</span>
          {starters.map((s) => (
            <button key={s} type="button" onClick={() => { setText(s); box.current?.focus(); }} className="max-w-full truncate rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs hover:bg-[var(--subtle)]">
              {s}
            </button>
          ))}
        </div>
      )}
      {quote && <div className="relative pe-8" aria-label="Replying to message">
        <QuotePreview quote={quote} quoteKey={draftKey} />
        <button type="button" aria-label="Cancel reply" title="Cancel reply" className="absolute end-0 top-1 p-1" onClick={() => setQuote(undefined)}>×</button>
      </div>}
      <form
        className={`relative flex flex-wrap items-end gap-x-1.5 gap-y-1.5 rounded-2xl border bg-[var(--surface)] px-1.5 py-1.5 shadow-[0_1px_2px_rgba(23,22,28,0.05)] sm:flex-col sm:flex-nowrap sm:items-stretch sm:gap-2 sm:px-3 sm:py-2.5 ${dragging ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/30' : 'border-[var(--border-strong)]'}`}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragging(false);
          attach(e.dataTransfer.files);
        }}
      >
        <label htmlFor={`composer-${draftKey}`} className="sr-only">
          {placeholder}
        </label>
        {picking && (
          <ul
            id={`mentions-${draftKey}`}
            role="listbox"
            aria-label="Mention someone"
            className="absolute bottom-full left-2 z-10 mb-1 w-64 max-w-[calc(100%-1rem)] overflow-hidden rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] py-1 shadow-lg"
          >
            {matches.map((m, i) => (
              <li
                key={m.id}
                id={`mention-${draftKey}-${m.id}`}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: keeps focus (and the caret) in the textarea.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m.name);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer truncate px-3 py-2 text-sm ${i === active ? 'bg-[var(--subtle)] font-medium' : ''}`}
              >
                @{m.name}
              </li>
            ))}
          </ul>
        )}
        <textarea
          id={`composer-${draftKey}`}
          ref={box}
          dir="auto"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            track(e.target);
          }}
          onSelect={(e) => track(e.currentTarget)}
          onBlur={() => setMention(null)}
          onPaste={(e) => {
            if (!e.clipboardData.files.length) return;
            e.preventDefault();
            attach(e.clipboardData.files);
          }}
          role={members.length ? 'combobox' : undefined}
          aria-autocomplete={members.length ? 'list' : undefined}
          aria-expanded={members.length ? picking : undefined}
          aria-controls={picking ? `mentions-${draftKey}` : undefined}
          aria-activedescendant={picking ? `mention-${draftKey}-${matches[active]?.id}` : undefined}
          onKeyDown={(e) => {
            if (picking) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pick(matches[active]!.name);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            // isComposing: Enter that confirms an IME candidate (e.g. Japanese input) doesn't send.
            // On touch screens return stays a newline, as in Slack; the Send button sends.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label="Message"
          className="order-2 max-h-[min(10lh,40dvh)] min-w-0 flex-1 basis-0 resize-none self-center overflow-y-auto sm:self-stretch bg-transparent py-1.5 text-base outline-none placeholder:text-[var(--muted)] sm:order-none sm:basis-auto sm:py-0 sm:text-[15px]"
        />
        {attachments.length > 0 && (
          <ul aria-label="Attachments" className="order-5 flex basis-full flex-wrap gap-1.5 sm:order-none">
            {attachments.map((a) =>
              a.preview ? (
                <li
                  key={a.key}
                  title={a.error ?? `${a.name} · ${formatSize(a.size)}`}
                  className={`relative size-16 shrink-0 overflow-hidden rounded-lg border ${a.status === 'failed' ? 'border-2 border-[var(--bad-fg)]' : 'border-[var(--border)]'}`}
                >
                  {/* Local blob: URL; nothing for next/image to optimize. */}
                  <img src={a.preview} alt={a.name} className={`size-full object-cover ${a.status === 'uploading' ? 'opacity-60' : ''}`} />
                  {a.status === 'uploading' && (
                    <span className="absolute inset-0 grid place-items-center">
                      <span role="status" aria-label="Uploading" className="size-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    </span>
                  )}
                  {a.status === 'failed' && <span className="sr-only">{a.error}</span>}
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    onClick={() => remove(a)}
                    className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-black/60 text-xs leading-none text-white hover:bg-black/80"
                  >
                    ×
                  </button>
                </li>
              ) : (
                <li
                  key={a.key}
                  title={a.error}
                  className={`flex max-w-full items-center gap-1.5 self-center rounded-lg border px-2 py-1 text-xs ${a.status === 'failed' ? 'border-[var(--bad-fg)] text-[var(--bad-fg)]' : 'border-[var(--border)]'}`}
                >
                  {a.status === 'uploading' && <span role="status" aria-label="Uploading" className="size-3 shrink-0 animate-spin rounded-full border-2 border-[var(--muted)] border-t-transparent" />}
                  <span className="truncate">{a.name}</span>
                  <span className="shrink-0 text-[var(--muted)]">{a.status === 'failed' ? `· ${a.error}` : formatSize(a.size)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${a.name}`}
                    onClick={() => remove(a)}
                    className="ml-0.5 shrink-0 rounded px-1 text-[var(--muted)] hover:bg-[var(--subtle)]"
                  >
                    ×
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
        {/* On phones these join the text row (display: contents); from sm up they are the row under it. */}
        <div className="contents sm:flex sm:items-center sm:gap-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) attach(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={attachments.length >= MAX_FILES}
            aria-label="Attach files"
            title="Attach files (or drop or paste them here), up to 25MB each"
            className="order-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--subtle)] disabled:opacity-40 sm:order-none"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <div className="order-3 flex shrink-0 items-center gap-3 sm:order-none sm:ml-auto">
            {/* Only where the composer itself is wide: in a narrow chat it pushed Send out of the box. */}
            <span className="hidden text-xs text-[var(--muted)] @lg:inline">Enter to send, Shift + Enter for a new line</span>
            <button
              className="btn-primary size-9 px-0 sm:size-auto sm:px-5"
              title={uploading ? 'Waiting for uploads to finish' : 'Enter'}
              disabled={uploading || (!text.trim() && !ready.length)}
            >
              <span className="hidden sm:inline">Send</span>
              <span className="sm:hidden" aria-hidden>
                <Icon name="send" size={18} />
              </span>
              <span className="sr-only sm:hidden">Send</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

/** Optimistic messages at the end of the thread: spinner while the POST is in flight, then steady until the server row lands. */
function SendingList({ items, me }: { items: OptimisticItem[]; me?: AvatarOf }) {
  return (
    <>
      {items.map((item) => (
        <div key={item.clientId} className="-mx-2 mt-2 flex gap-3 rounded-lg px-2 py-1" aria-live="polite" data-optimistic-id={item.clientId}>
          <div className="w-9 shrink-0">{me && <Avatar who={me} className="size-9" />}</div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2">
              <span className="font-semibold">You</span>
              {me?.role && <span className="chip">{me.role}</span>}
              {item.sending && <span role="status" aria-label="Sending" className="size-3 animate-spin rounded-full border-2 border-[var(--muted)] border-t-transparent" />}
            </p>
            {item.replyTo && <QuotePreview quote={item.replyTo} quoteKey={item.draftKey} />}
            <p dir="auto" className="break-words whitespace-pre-wrap [unicode-bidi:plaintext]">{item.display}</p>
          </div>
        </div>
      ))}
    </>
  );
}
