'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Markdown } from '@/components/Markdown';
import { ImagePreview } from '@/components/ImagePreview';
import { saveCanvasNote } from '@/lib/actions/canvas';
import { uploadFile } from '@/lib/upload';
import type { CanvasBox, CanvasNote } from '@/lib/hub';

export function noteFileHref(ws: string, note: string, file: string) {
  return `/api/workspaces/${encodeURIComponent(ws)}/notes/${encodeURIComponent(note)}/files/${encodeURIComponent(file)}`;
}

function NoteImage({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="text-sm text-[var(--muted)]">Image unavailable: {name}</p> : <div onErrorCapture={() => setFailed(true)}><ImagePreview src={src} name={name} /></div>;
}

export function NoteContent({ ws, note }: { ws: string; note: CanvasNote }) {
  return <div className="flex flex-col gap-3">
    {note.text && <Markdown text={note.text} />}
    {note.files.map((file) => <NoteImage key={file.id} src={noteFileHref(ws, note.id, file.id)} name={file.name} />)}
  </div>;
}

export function CanvasNoteCard({ ws, note, editable, scale = 1, placed = false, onEdit, onMove }: {
  ws: string; note: CanvasNote; editable: boolean; scale?: number; placed?: boolean;
  onEdit: () => void; onMove: (canvas: CanvasBox) => Promise<void>;
}) {
  const [box, setBox] = useState<CanvasBox>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; box: CanvasBox; next?: CanvasBox; mode: 'move' | 'resize' } | null>(null);
  const actual = box ?? note.canvas;
  const persist = async (next: CanvasBox) => {
    setBusy(true); setError('');
    try { await onMove(next); } catch (error) { setError(error instanceof Error ? error.message : 'Could not move note'); }
    finally { setBusy(false); setBox(undefined); }
  };
  const handle = (mode: 'move' | 'resize') => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (event.button !== 0 || busy) return;
      drag.current = { x: event.clientX, y: event.clientY, box: note.canvas, mode };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      const d = drag.current; if (!d) return;
      const dx = (event.clientX - d.x) / scale, dy = (event.clientY - d.y) / scale;
      const next = d.mode === 'move' ? { ...d.box, x: Math.max(-1e6, Math.min(1e6, d.box.x + dx)), y: Math.max(-1e6, Math.min(1e6, d.box.y + dy)) } : { ...d.box, w: Math.max(180, Math.min(2000, d.box.w + dx)), h: Math.max(120, Math.min(2000, d.box.h + dy)) };
      d.next = next; setBox(next);
    },
    onPointerUp: () => { const next = drag.current?.next; drag.current = null; if (next) void persist(next); },
    onPointerCancel: () => { drag.current = null; setBox(undefined); },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const deltas: Record<string, [number, number]> = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
      const delta = deltas[event.key]; if (!delta || busy) return;
      event.preventDefault(); event.stopPropagation();
      const next = mode === 'move' ? { ...note.canvas, x: note.canvas.x + delta[0], y: note.canvas.y + delta[1] } : { ...note.canvas, w: Math.max(180, Math.min(2000, note.canvas.w + delta[0])), h: Math.max(120, Math.min(2000, note.canvas.h + delta[1])) };
      void persist(next);
    },
  });
  return <article aria-label="Canvas note" data-canvas-note={note.id} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    style={placed ? { position: 'absolute', left: actual.x, top: actual.y, width: actual.w, height: actual.h } : undefined}
    className="relative flex min-w-0 flex-col overflow-hidden rounded-[20px] border border-[var(--border-strong)] bg-[var(--surface)] shadow-sm">
    <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
      {placed && editable ? <button type="button" disabled={busy} {...handle('move')} aria-label="Move note (arrow keys)" className="min-h-11 flex-1 cursor-grab touch-none text-left text-sm font-semibold">Note</button> : <span className="flex-1 text-sm font-semibold">Note</span>}
      {editable && <button type="button" onClick={onEdit} disabled={busy} className="min-h-11 px-2 text-sm text-[var(--accent)]">Edit</button>}
    </header>
    <div className="min-h-0 overflow-auto p-4 select-text touch-pan-y"><NoteContent ws={ws} note={note} /></div>
    {error && <p role="alert" className="px-4 pb-2 text-sm text-[var(--bad-fg)]">{error}</p>}
    {placed && editable && <button type="button" disabled={busy} {...handle('resize')} aria-label="Resize note (arrow keys)" title="Resize note" className="absolute right-0 bottom-0 flex size-9 cursor-se-resize touch-none items-center justify-center rounded-tl-xl bg-[var(--surface)] text-[var(--muted)]">↘</button>}
  </article>;
}

export function NoteEditor({ ws, note, canvas, onSaved, onDelete, onClose }: {
  ws: string; note?: CanvasNote; canvas: CanvasBox; onSaved: (note: CanvasNote) => void;
  onDelete: () => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(note?.text ?? '');
  const [files, setFiles] = useState(note?.files ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const save = async () => {
    setBusy(true); setError('');
    try {
      const result = await saveCanvasNote(ws, { text, files: files.map((file) => file.id), canvas, ...(note ? { version: note.version } : {}) }, note?.id);
      if (!result.ok) return setError(result.error);
      onSaved(result.note);
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save note'); }
    finally { setBusy(false); }
  };
  const attach = async (selected: FileList | null) => {
    if (!selected?.length) return;
    setError('');
    if (files.length + selected.length > 10) return setError('A note supports up to 10 images');
    if ([...selected].some((file) => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))) return setError('Choose PNG, JPEG, GIF or WebP images');
    setBusy(true);
    try {
      for (const file of selected) {
        const id = await uploadFile(file);
        setFiles((current) => [...current, { id, name: file.name, mediaType: file.type }]);
      }
    } catch (error) { setError(error instanceof Error ? error.message : 'Upload failed'); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} aria-labelledby="note-editor-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !busy) { event.preventDefault(); void save(); } }}
    className="m-auto max-h-[calc(100dvh-24px)] w-[min(640px,calc(100vw-24px))] overflow-y-auto rounded-[24px] border border-[var(--border)] bg-[var(--bg)] p-5 text-[var(--fg)] shadow-xl backdrop:bg-black/30">
    <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="flex flex-col gap-4">
      <div className="flex items-center gap-3"><h2 id="note-editor-title" className="flex-1 text-lg font-bold">{note ? 'Edit note' : 'Add note'}</h2><button type="button" disabled={busy} onClick={onClose} className="btn">Cancel</button></div>
      <div className="flex flex-wrap gap-2"><button type="button" disabled={busy} onClick={() => setPreview(!preview)} aria-pressed={preview} className="btn">{preview ? 'Write Markdown' : 'Preview'}</button><label className={`btn ${busy ? 'opacity-50' : ''}`}>Add image / GIF<input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" disabled={busy} className="sr-only" onChange={(event) => { void attach(event.target.files); event.target.value = ''; }} /></label></div>
      {preview ? <div className="min-h-40 rounded-xl border border-[var(--border)] p-3"><Markdown text={text || 'Nothing to preview yet.'} /></div> : <label className="flex flex-col gap-2 text-sm">Markdown<textarea disabled={busy} autoFocus aria-label="Note Markdown" value={text} onChange={(event) => setText(event.target.value)} maxLength={20_000} rows={7} className="input w-full resize-y font-mono" placeholder="Write a note…" /></label>}
      {files.map((file) => <div key={file.id} className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--border)] p-2"><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm">{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} disabled={busy} onClick={() => setFiles(files.filter((item) => item.id !== file.id))} className="btn">Remove</button></div><NoteImage src={note?.files.some((item) => item.id === file.id) ? noteFileHref(ws, note.id, file.id) : `/api/files/${encodeURIComponent(file.id)}`} name={file.name} /></div>)}
      <p className="text-xs text-[var(--muted)]">Images use the same retention policy as chat uploads (90 days by default).</p>
      {error && <p role="alert" className="text-sm text-[var(--bad-fg)]">{error}</p>}
      {confirmDelete && <div role="group" aria-label="Confirm delete note" className="rounded-xl border border-[var(--bad-fg)] p-3 text-sm"><p>Delete this note for everyone?</p><div className="mt-2 flex gap-2"><button type="button" disabled={busy} className="btn" onClick={async () => { setBusy(true); try { await onDelete(); } catch (error) { setError(error instanceof Error ? error.message : 'Could not delete note'); } finally { setBusy(false); } }}>Delete note</button><button type="button" disabled={busy} className="btn" onClick={() => setConfirmDelete(false)}>Keep note</button></div></div>}
      <div className="flex gap-2">{note && <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)} className="btn text-[var(--bad-fg)]">Delete…</button>}<button type="submit" disabled={busy || (!text.trim() && !files.length)} className="btn-primary ml-auto">{busy ? 'Working…' : 'Save note'}</button></div>
    </form>
  </dialog>, document.body);
}
