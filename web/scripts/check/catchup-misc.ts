import { tidyLayout, type Frame } from '../../lib/canvasLayout';
import { CreateVoucherForm, RedeemVoucherForm } from '../../components/Vouchers';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CanvasNoteCard, NoteContent, noteFileHref } from '../../components/CanvasNotes';
import { SelectedAgentCard } from '../../components/CanvasPanels';
import { Composer } from '../../components/Composer';
import { Timeline, ThreadView } from '../../components/Thread';
import { Markdown } from '../../components/Markdown';
import { EmptyCanvasCard } from '../../components/CanvasModals';
import { HireOrConnect, hireOrConnectUrl } from '../../components/ClientTabs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MessageView } from '../../lib/hub';
import { message, people, noop } from './fixtures';

// List direction must come from the item text, not dir=auto around a nested explicitly-directed Markdown block.
const mixedMessageHtml = renderToStaticMarkup(createElement(Markdown, { text: '- החלטנו לפרסם אחרי בדיקות\n- PR #311 אושר על ידי גיטית לתיקון כיווניות RTL\n- Review the release' }));
assert.match(mixedMessageHtml, /<li[^>]*dir="rtl">PR #311/);
assert.match(mixedMessageHtml, /<li[^>]*dir="ltr">/);
const globalsCssSrc = readFileSync(path.resolve(import.meta.dirname, '../../app/globals.css'), 'utf8');
assert.doesNotMatch(
  globalsCssSrc,
  /\.md\s+:is\(p,\s*li\)\s*\{[^}]*unicode-bidi:\s*plaintext/,
  '.md p/li must not set unicode-bidi: plaintext, which overrides dir="rtl" when a Hebrew item starts with an English token and splits the bullet from its text',
);
// Archiving an agent must hit the real hub route (POST/DELETE /agents/:id/archive), not the nonexistent PUT /agents/:id/archived which 404s silently with no indication.
const agentsActionsSrc = readFileSync(path.resolve(import.meta.dirname, '../../lib/actions/agents.ts'), 'utf8');
assert.ok(
  agentsActionsSrc.includes("/archive`, { method: archived ? 'POST' : 'DELETE' }"),
  "setArchived must call POST (archive) / DELETE (restore) on /agents/:id/archive",
);
assert.ok(!/\/agents\/[^`]*\/archived`/.test(agentsActionsSrc), 'setArchived must not target the nonexistent /agents/:id/archived route');

const voucherCreateHtml = renderToStaticMarkup(createElement(CreateVoucherForm, { action: async () => ({ ok: true as const, message: 'Created' }) }));
assert.match(voucherCreateHtml, /Redeem by \(end of day UTC\)/);
assert.match(voucherCreateHtml, /100 credits = \$1 of usage/);
assert.match(voucherCreateHtml, /Maximum unique users/);
const voucherRedeemHtml = renderToStaticMarkup(createElement(RedeemVoucherForm, { action: async () => ({ ok: true as const, message: 'Applied' }) }));
assert.match(voucherRedeemHtml, /Redeem a voucher/);
assert.match(voucherRedeemHtml, /name="code"/);
assert.doesNotMatch(voucherRedeemHtml, /name="(?:credits|ownerId|maxUses)"/);

// Empty workspaces offer the next step without duplicate hire/connect or Slack actions.
for (const hasAgents of [false, true]) {
  const html = renderToStaticMarkup(createElement(EmptyCanvasCard, { ws: 'ws1', me: { id: 'me', name: 'Me' }, hasAgents, onCreateTeam: () => {} }));
  assert.doesNotMatch(html, /Connect Slack|Hire an agent in seconds|Connect one you use/);
  if (hasAgents) {
    assert.match(html, /Create your first team/);
    assert.doesNotMatch(html, /href=.*connect/);
  } else {
    assert.match(html, /href="\/w\/ws1\/connect"/);
    assert.equal((html.match(/>Add an agent</g) ?? []).length, 1);
  }
}

const connectPageSrc = readFileSync(path.resolve(import.meta.dirname, '../../app/(window)/w/[ws]/connect/page.tsx'), 'utf8');
assert.match(connectPageSrc, /const cloud = rawClient === 'cloud' && !!\(user\.cloud \|\| user\.hire\);/, 'Connect page selects the free option by default unless client=cloud');
// Add agent: Hire/Connect switch on the client (buttons, not links, both branches mounted, the off one hidden), no credits strip, revoke stays in the workspace.
const hireOrConnectHtml = renderToStaticMarkup(createElement(HireOrConnect, { initialCloud: false, canHire: true, client: 'codex', hire: createElement('p', null, 'HIRE-MARKER'), connect: createElement('p', null, 'CONNECT-MARKER') }));
assert.equal((hireOrConnectHtml.match(/<button/g) ?? []).length, 2);
assert.doesNotMatch(hireOrConnectHtml, /href=/);
assert.match(hireOrConnectHtml, /<div hidden="">\s*<p>HIRE-MARKER<\/p><\/div><div><p>CONNECT-MARKER<\/p><\/div>/);
{
  // Opened on Claude, Codex picked in the tabs (they set ?client=codex): clicking the active Connect card changes nothing.
  const page = 'https://parly.dev/w/ws1/connect?client=codex';
  assert.equal(hireOrConnectUrl(page, false, false, 'claude'), null);
  // Hire, then Connect again: back on Codex, not the client the page opened with.
  const hire = hireOrConnectUrl(page, false, true, 'claude')!;
  assert.equal(new URL(hire.href).searchParams.get('client'), 'cloud');
  const back = hireOrConnectUrl(hire.href, true, false, hire.last)!;
  assert.equal(new URL(back.href).searchParams.get('client'), 'codex');
  assert.equal(hireOrConnectUrl(back.href, false, false, back.last), null);
}
assert.doesNotMatch(connectPageSrc, /PlanStrip/, 'Add agent dialog has no credits strip');
assert.doesNotMatch(agentsActionsSrc.slice(agentsActionsSrc.indexOf('export async function revokeConnection'), agentsActionsSrc.indexOf('export async function requestClient')), /connectBack\(/, 'revokeConnection returns to the workspace dialog, not /connect');


const noteFixture = { id: 'n1', workspaceId: 'ws1', authorId: 'author', text: '**Launch**', files: [{ id: 'f1', name: 'launch.gif', mediaType: 'image/gif' }], canvas: { x: 40, y: 80, w: 320, h: 300 }, createdAt: '2026-10-28', updatedAt: '2026-10-28', version: 1 };
const noteHtml = renderToStaticMarkup(createElement(NoteContent, { ws: 'ws1', note: noteFixture }));
assert.match(noteHtml, /<strong>Launch<\/strong>/);
assert.match(noteHtml, /\/api\/workspaces\/ws1\/notes\/n1\/files\/f1/);
assert.doesNotMatch(noteHtml, /src="\/api\/files/);
assert.equal(noteFileHref('ws /', 'note /', 'file /'), '/api/workspaces/ws%20%2F/notes/note%20%2F/files/file%20%2F');
for (const editable of [false, true]) {
  const html = renderToStaticMarkup(createElement(CanvasNoteCard, { ws: 'ws1', note: noteFixture, editable, placed: true, onEdit: noop, onMove: async () => {} }));
  assert.equal(html.includes('Move note (arrow keys)'), editable);
  assert.equal(html.includes('Resize note (arrow keys)'), editable);
  assert.equal(html.includes('>Edit</button>'), editable);
}

// A showcase guest: the showcase's agents talk only at its tables, so their cards offer no DM and no "take out of team".
{
  const bot = { id: 'crew1', name: 'Judge', kind: 'endpoint', avatar: 'crew1', presence: { state: 'quiet' }, teams: ['t1'] };
  const team = { channelId: 't1', name: 'table', canvas: { x: 0, y: 0, w: 580, h: 420 }, members: ['crew1'] } as never;
  const card = (guest: boolean) =>
    renderToStaticMarkup(createElement(SelectedAgentCard, { ws: 'ws1', guest, meId: 'me', agent: bot as never, teams: [team], selTeamId: 't1', onSelectTeam: noop, onOpenLog: noop, onRemoveFromTeam: noop, onClose: noop }));
  assert.match(card(false), /\/w\/ws1\/c\/agent%3Acrew1/);
  assert.doesNotMatch(card(true), /\/w\/ws1\/c\/agent%3Acrew1/);
  assert.match(card(false), /Take out of table/);
  assert.doesNotMatch(card(true), /Take out of table/);
}

// A channel's starters show as one-tap chips above an empty box, not in a thread.
{
  const base = { draftKey: 'c1', workspaceId: 'ws1', channelId: 'c1', placeholder: 'Message #a-or-b', starters: ['iPhone or Pixel?'] };
  assert.match(renderToStaticMarkup(createElement(Composer, base)), />iPhone or Pixel\?<\/button>/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(Composer, { ...base, thread: 'p1' })), /iPhone or Pixel\?/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(Composer, { ...base, starters: [] })), /Examples to start with/);
}

// A note where Tidy used to put a team must remain uncovered, including tall mixed-size teams.
{
  const teams: Frame[] = Array.from({ length: 5 }, (_, i) => ({ id: `team-${i}`, x: 40, y: 40, w: 400 + i * 30, h: 200 + i * 80 }));
  const notes: Frame[] = Array.from({ length: 8 }, (_, i) => ({ id: `note-${i}`, x: 40 + (i % 3) * 350, y: 40 + Math.floor(i / 3) * 280, w: 320, h: 250 }));
  const originalNotes = JSON.stringify(notes);
  const positions = tidyLayout(teams, notes);
  const placed = teams.map((team) => ({ ...team, ...positions.get(team.id)! }));
  const overlaps = (a: Frame, b: Frame) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (const [i, team] of placed.entries()) {
    assert.ok(notes.every((note) => !overlaps(team, note)), 'Tidy must not cover a fixed note');
    assert.ok(placed.slice(i + 1).every((other) => !overlaps(team, other)), 'Tidied teams must not overlap');
  }
  assert.equal(JSON.stringify(notes), originalNotes, 'Tidy must preserve notes');
  assert.equal(tidyLayout([], notes).size, 0);
  assert.deepEqual(tidyLayout([teams[0]!]).get('team-0'), { x: 40, y: 40 });
}

// Loaded skills & processes on a message: distinct-color pills linking to /w/[ws]/skills/[id] (no "Used:" prefix), nothing when empty, wrap with 4px gap and 200px max pill width.
{
  const plainMsg = { ...message(1, 'bot', 'Checked.'), conversation: 'channel:c', channelId: 'c' };
  const emptySkillsMsg = { ...message(2, 'bot', 'Still checked.'), conversation: 'channel:c', channelId: 'c', skills: [] };
  const noPillsHtml = renderToStaticMarkup(
    createElement(Timeline, { messages: [plainMsg, emptySkillsMsg], meId: 'me', hrefBase: '/c', ws: 'ws1', people, channel: true }),
  );
  assert.doesNotMatch(noPillsHtml, /\/w\/ws1\/skills\//);

  const loadedMsg: MessageView = {
    ...message(1, 'bot', 'Reviewed the diff and followed the process.'),
    conversation: 'channel:c',
    channelId: 'c',
    skills: [
      { id: 'b96ce4a7', name: 'feature-dev', type: 'process' },
      { id: 'builtin:skill-writer', name: 'skill-writer-with-a-very-long-name-for-mobile', type: 'skill' },
    ],
  };
  const pillsHtml = renderToStaticMarkup(
    createElement(Timeline, { messages: [loadedMsg], meId: 'me', hrefBase: '/c', ws: 'ws1', people, channel: true }),
  );
  assert.doesNotMatch(pillsHtml, />Used:<\/span>/);
  assert.match(pillsHtml, /mt-1\.5 flex flex-wrap items-center gap-1 text-xs/);
  const processPillMatch = pillsHtml.match(
    /title="feature-dev" class="([^"]*max-w-\[200px\] truncate[^"]*)" href="\/w\/ws1\/skills\/b96ce4a7">feature-dev<\/a>/,
  );
  const skillPillMatch = pillsHtml.match(
    /title="skill-writer-with-a-very-long-name-for-mobile" class="([^"]*max-w-\[200px\] truncate[^"]*)" href="\/w\/ws1\/skills\/builtin%3Askill-writer">skill-writer-with-a-very-long-name-for-mobile<\/a>/,
  );
  assert.ok(processPillMatch, 'process pill rendered with link and title');
  assert.ok(skillPillMatch, 'skill pill rendered with link and title');
  assert.match(processPillMatch[1]!, /bg-\[var\(--warn-bg\)\] text-\[var\(--warn-fg\)\]/);
  assert.match(skillPillMatch[1]!, /bg-\[var\(--accent-soft\)\] text-\[var\(--accent-ink\)\]/);
  assert.notEqual(processPillMatch[1], skillPillMatch[1], 'process and skill pills must get different color classes');
  assert.ok(
    pillsHtml.indexOf('Reviewed the diff') < pillsHtml.indexOf('/w/ws1/skills/b96ce4a7'),
    'skill/process pills render below the message body',
  );

  const threadWithPillsHtml = renderToStaticMarkup(
    createElement(ThreadView, {
      post: plainMsg,
      replies: [
        {
          ...message(2, 'bot', 'Reply with skill'),
          conversation: 'thread:c:m1',
          thread: 'm1',
          skills: [{ id: '3c31f198', name: 'code-review', type: 'skill' }],
        },
      ],
      meId: 'me',
      ws: 'ws1',
      people,
    }),
  );
  assert.doesNotMatch(threadWithPillsHtml, />Used:<\/span>/);
  assert.match(threadWithPillsHtml, /href="\/w\/ws1\/skills\/3c31f198"[^>]*>code-review<\/a>/);
}
