import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountMenu, WorkspaceMenu } from '../../components/AccountMenu';
import { menuWorkspace } from '../../lib/menuWorkspace';
import { attentionCount, attentionGroups, markDestinationRead } from '../../lib/attention';
import { CanvasChrome } from '../../components/CanvasWorld';
import { byRecent, hasFrameMoved, joinBoxes } from '../../components/crew-canvas/helpers';
import { AddToTeam, EmptyCanvasCard } from '../../components/CanvasModals';
import { workspaceRoster } from '../../components/CanvasHome';
import { statusStale } from '../../lib/labels';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { noop } from './fixtures';

// 2. Mobile cards order (byRecent): initial order sorts newest conversation first, but locking the order prevents
//    background LiveRefresh updates from swapping a different channel card under the user's finger mid-tap.
const cardTeams = [
  { channelId: 'ch-a', name: 'Alpha', members: [], needsYou: 0, canvas: { x: 0, y: 0, w: 400, h: 300 } },
  { channelId: 'ch-b', name: 'Beta', members: [], needsYou: 0, canvas: { x: 450, y: 0, w: 400, h: 300 } },
];
const initialOrder = byRecent(cardTeams, [
  { key: 'channel:ch-a', title: '#Alpha', preview: 'hi', unread: 0, updatedAt: '2026-10-25T03:00:00Z' },
  { key: 'channel:ch-b', title: '#Beta', preview: 'yo', unread: 0, updatedAt: '2026-10-25T02:00:00Z' },
]);
assert.deepEqual(initialOrder.map((t) => t.channelId), ['ch-a', 'ch-b']);
const lockedIds = initialOrder.map((t) => t.channelId);
const afterBackgroundRefresh = byRecent(
  cardTeams,
  [
    { key: 'channel:ch-a', title: '#Alpha', preview: 'hi', unread: 0, updatedAt: '2026-10-25T03:00:00Z' },
    { key: 'channel:ch-b', title: '#Beta', preview: 'new msg!', unread: 1, updatedAt: '2026-10-25T03:05:00Z' },
  ],
  lockedIds,
);
assert.deepEqual(
  afterBackgroundRefresh.map((t) => t.channelId),
  ['ch-a', 'ch-b'],
  'Locked card order must not swap ch-b into ch-a slot during background LiveRefresh',
);

// 3. Team frame tap vs drag threshold is measured in screen pixels (not divided by overview zoom scale s=0.3).
assert.equal(hasFrameMoved(100, 100, 102, 101), false, 'Small 2px touch jitter on a team frame is a tap, not a drag');
assert.equal(hasFrameMoved(100, 100, 108, 100), true, 'Movement > 6 screen px starts a frame drag');

// Add-member picker (AddToTeam): offers people as well as agents, and its copy says "member", not "agent".
const addMemberHtml = renderToStaticMarkup(
  createElement(AddToTeam, {
    ws: 'ws1',
    team: { channelId: 'ch1', name: 'dev', canvas: { x: 0, y: 0, w: 400, h: 300 }, members: [], needsYou: 0 },
    agents: [
      { id: 'bot', name: 'Botty', kind: 'mailbox', avatar: '' },
      { id: 'person', name: 'Dana', kind: 'human', avatar: '' },
    ],
    onPick: () => {},
    onClose: () => {},
  }),
);
assert.match(addMemberHtml, /Add member to dev/, 'Picker is labelled "Add member", not "Add an agent"');
assert.match(addMemberHtml, /Find a member/, 'Picker search says "Find a member"');
assert.doesNotMatch(addMemberHtml, /Find an agent/, 'Member search includes people');
assert.match(addMemberHtml, /href="\/w\/ws1\/connect\?team=ch1"/, 'Adding a new agent keeps the team without overriding the free default');
assert.match(addMemberHtml, />Dana</, 'A person (human) is offered in the member picker, not only agents');
assert.match(addMemberHtml, />Botty</, 'An agent is still offered in the member picker');


// workspaceRoster: the roster fed to the Add-member picker includes workspace PEOPLE (not just agents),
// and excludes archived members and anyone already placed on the canvas. This is what makes "add a person" work
// for someone not yet on any team.
const rosterMembers = [
  { id: 'bot', name: 'Botty', description: '', kind: 'mailbox' as const, public: false, skills: [], workspaces: [], channels: [], lastSeen: '2026-10-08T00:00:00Z' },
  { id: 'person', name: 'Dana', description: '', kind: 'human' as const, public: false, skills: [], workspaces: [], channels: [], lastSeen: '2026-10-08T00:00:00Z' },
  { id: 'arch', name: 'Old', description: '', kind: 'mailbox' as const, public: false, skills: [], workspaces: [], channels: [], lastSeen: '2026-10-08T00:00:00Z', archived: true },
  { id: 'placed', name: 'Placed', description: '', kind: 'human' as const, public: false, skills: [], workspaces: [], channels: [], lastSeen: '2026-10-08T00:00:00Z' },
];
const roster = workspaceRoster(rosterMembers, new Set(['placed']));
assert.deepEqual(roster.map((a) => a.id).sort(), ['bot', 'person'], 'Roster includes a person + agent, excludes archived and already-placed');
assert.equal(roster.find((a) => a.id === 'person')?.kind, 'human', 'A workspace person reaches the picker so they can be added as a member');

// Status staleness (FleetView bubbles): a fresh status is current work; one past the window reads as idle.
assert.equal(statusStale({ at: new Date(Date.now() - 10 * 60_000).toISOString() }), false, 'A 10-minute-old status is still current work');
assert.equal(statusStale({ at: new Date(Date.now() - 5 * 3_600_000).toISOString() }), true, 'A 5-hour-old status is stale (shown as Idle, not the old activity)');
assert.equal(statusStale({ at: new Date(Date.now() - 45 * 60_000).toISOString() }), true, 'A 45-minute-old status is stale under the 30-minute window (not current work)');
assert.equal(statusStale(undefined), false, 'No status is not stale');
assert.equal(statusStale({ at: new Date().toISOString(), text: 'Done: PR #12' }), true, 'A fresh "Done: …" status reads as finished, not current work');
assert.equal(statusStale({ at: new Date().toISOString(), text: 'Auditing Strata tranches' }), false, 'A fresh in-progress status is current');

// A slow send may finish after the user opens another chat: acknowledging it must never navigate back.
assert.doesNotMatch(readFileSync(path.resolve(import.meta.dirname, '../../components/Composer.tsx'), 'utf8'), /router\.(push|replace)\s*\(/, 'Composer must acknowledge sends without changing the current route');

// Workspace navigation never leaks into the personal account menu, and each creation action has one destination.
const navSpaces = [{ id: 'ws1', name: 'Workspace one' }, { id: 'ws2', name: 'Workspace two' }, { id: 'room', name: 'Shared room', room: { others: ['Partner'], needsSetup: true } }];
const workspaceMenuHtml = renderToStaticMarkup(createElement(WorkspaceMenu, { ws: 'ws1', workspaceName: 'Workspace one', workspaces: navSpaces }));
assert.match(workspaceMenuHtml, /aria-label="Workspace: Workspace one"/);
for (const url of ['/w/ws2', '/w/ws1?panel=workspace']) assert.ok(workspaceMenuHtml.includes(`href="${url}"`), url);
assert.doesNotMatch(workspaceMenuHtml, /href="\/(account|billing)"|Connected apps|Skills &amp; processes|Triggers/);

// An app's rooms: one row per app (to its rooms in Developers), never one row each, and never "Set up your side".
const appRoom = (id: string) => menuWorkspace({ id, name: `Evaluate fit ${id}`, room: { goal: 'g', shared: 's', sides: [{ id: 'a', name: 'Company' }, { id: 'b', name: 'Candidate' }], appId: 'app1', app: { id: 'app1', name: 'Hireroom', workspaceId: 'hq' } } } as never);
assert.equal(appRoom('r1').room!.needsSetup, false);
const appMenuHtml = renderToStaticMarkup(createElement(WorkspaceMenu, { ws: 'r1', workspaceName: 'Evaluate fit r1', workspaces: [...navSpaces, appRoom('r1'), appRoom('r2')] }));
assert.ok(appMenuHtml.includes('href="/w/hq/developers#app-app1"'));
assert.match(appMenuHtml, /Hireroom.*2 rooms/);
assert.doesNotMatch(appMenuHtml, /Evaluate fit r2/);
assert.equal(appMenuHtml.match(/Set up your side/g)?.length, 1); // the hand-made room only
// A deleted app's rooms (appId, no app) don't fall back into Shared rooms.
const orphan = menuWorkspace({ id: 'r3', name: 'Orphan room', room: { goal: 'g', shared: 's', sides: [{ id: 'a', name: 'Company' }], appId: 'gone' } } as never);
assert.doesNotMatch(renderToStaticMarkup(createElement(WorkspaceMenu, { ws: 'ws1', workspaceName: 'Workspace one', workspaces: [...navSpaces, orphan] })), /Orphan room/);
const accountMenuHtml = renderToStaticMarkup(createElement(AccountMenu, { me: { id: 'me', name: 'Dana', admin: true }, logout: async () => {} }));
assert.match(accountMenuHtml, /aria-label="Dana: your account"/);
for (const url of ['/account', '/billing', '/docs', '/admin']) assert.ok(accountMenuHtml.includes(`href="${url}"`), url);
assert.doesNotMatch(accountMenuHtml, /Workspace settings|New workspace|Shared rooms/);
const waitingOne = { kind: 'mention' as const, replyTo: 'thread:ch1:p1', open: 'thread:ch1:p1', channelId: 'ch1', from: 'Bot', fromId: 'bot', text: 'Please review', at: '2026-10-26T12:00:00Z' };
const convOne = { key: 'channel:ch1', title: 'Team', preview: 'New reply', unread: 1, thread: 'p1', updatedAt: waitingOne.at };
const overlap = attentionGroups([waitingOne], [convOne]);
assert.equal(overlap.waiting.length + overlap.unread.length, 1, 'The same destination in Waiting and Unread counts once');
assert.equal(overlap.recent.length, 0, 'Actionable destinations are absent from Recent');
const separate = attentionGroups([waitingOne, { ...waitingOne, replyTo: 'thread:ch1:p2' }, waitingOne], []);
assert.equal(separate.waiting.length, 2, 'Different threads in the same channel remain distinct; duplicate Waiting rows collapse');
assert.equal(attentionGroups([waitingOne, { ...waitingOne, at: '2026-10-26T13:00:00Z', text: 'Latest' }], []).waiting[0]?.text, 'Latest', 'Duplicate waiting destinations retain their latest reply');
const remainder = attentionGroups([waitingOne], [{ ...convOne, unread: 3 }]);
assert.equal(remainder.unread.length, 1, 'Other aggregate channel unread messages remain accessible');
assert.equal(remainder.unread[0]?.thread, undefined, 'The remainder opens the channel, not the already-listed thread');
assert.equal(attentionGroups([{ ...waitingOne, kind: 'dm', replyTo: 'agent:bot' }], [{ ...convOne, key: 'agent:bot', thread: undefined, unread: 5 }]).unread.length, 0, 'DM overlap is one destination regardless of message count');
const dmWaiting = { ...waitingOne, kind: 'dm' as const, replyTo: 'agent:bot', channelId: undefined };
const dmConv = { ...convOne, key: 'agent:bot', thread: undefined };
assert.equal(attentionCount(attentionGroups([dmWaiting], [dmConv])), 1);
assert.equal(attentionCount(attentionGroups([], markDestinationRead([dmConv], dmWaiting.replyTo))), 0, 'Opening a Needs you DM drops the count to 0');
const twoMentions = markDestinationRead([{ ...convOne, unread: 2, mentions: 2 }], waitingOne.replyTo);
assert.equal(attentionCount(attentionGroups([], twoMentions)), 0, 'Opening a thread with two mentions reads all of it');
const recentOnly = attentionGroups([], [{ ...convOne, key: 'agent:read', unread: 0, thread: undefined }, convOne]);
assert.equal(recentOnly.recent.length, 1, 'Recent contains only read conversations');

const navElement = createElement(CanvasChrome, {
  ws: 'ws1', workspaceName: 'Workspace one', me: { id: 'me', name: 'Dana' }, workspaces: navSpaces, logout: async () => {},
  billing: { plan: 'free', leftUsd: 5, used: 0.1 },
  botAgentsCount: 3, attentionCount: 1, showNewTeam: false, cards: true, showBench: false, overview: true, s: 1,
  onFitAll: noop, onSwitchLayout: noop, onToggleBench: noop, onNewTeam: noop, onTidyUp: noop, onZoomIn: noop, onZoomOut: noop,
});
const navHtml = renderToStaticMarkup(navElement);
const billingNotice = navHtml.match(/<a[^>]*role="status"[^>]*class="([^"]*)"[^>]*>(.*?)<\/a>/);
assert.ok(billingNotice, 'Free users retain a billing notice below 80% usage');
assert.match(billingNotice[2], /Upgrade to Pro/);
assert.doesNotMatch(billingNotice[1], /(?:^|\s)hidden(?:\s|$)/, 'Billing notice stays visible on mobile');
assert.doesNotMatch(navHtml, /aria-label="New"/);
assert.equal((navHtml.match(/data-tour="new-team"/g) ?? []).length, 1);
assert.match(navHtml, /href="\/w\/ws1\/connect"/);
assert.doesNotMatch(navHtml, /connect\?client=/);
assert.equal((navHtml.match(/data-tour="search"/g) ?? []).length, 1);
assert.equal((navHtml.match(/data-tour="workspace-settings"/g) ?? []).length, 1);
assert.equal((navHtml.match(/data-tour="billing"/g) ?? []).length, 1);
assert.doesNotMatch(navHtml, /aria-label="Actions"|aria-label="Workspace settings"/);
assert.equal((navHtml.match(/data-attention-count/g) ?? []).length, 1, 'Only search has an attention badge');
assert.match(navHtml, /aria-label="Search or jump \(⌘K\), 1 needs you"/);
assert.doesNotMatch(navHtml, /Search and conversations|[0-9]+ unread/);
assert.doesNotMatch(navHtml, /data-tour="needs-you"|aria-label="Needs you/);
assert.match(navHtml, /<button[^>]*data-tour="search"[^>]*>[\s\S]*?data-attention-count[\s\S]*?<\/button>/);

const emptyNavHtml = renderToStaticMarkup(createElement(CanvasChrome, { ...navElement.props, attentionCount: 0 }));
assert.doesNotMatch(emptyNavHtml, /data-attention-count/);
assert.match(emptyNavHtml, /aria-label="Search or jump \(⌘K\)"/);
assert.ok(navHtml.indexOf('data-tour="account"') < navHtml.indexOf('data-tour="search"'));
assert.ok(navHtml.indexOf('data-tour="workspace"') < navHtml.indexOf('data-tour="search"'));
assert.ok(navHtml.indexOf('data-tour="search"') < navHtml.indexOf('aria-label="Canvas actions"'));
assert.match(navHtml, /Connected apps/);
assert.match(navHtml, /Skills &amp; processes/);
assert.match(navHtml, /Triggers/);

const canvasMenuHtml = navHtml.slice(navHtml.indexOf('aria-label="Canvas actions"')).split('</details>')[0]!;
for (const label of ['Connected apps', 'Skills &amp; processes', 'Triggers', 'New team / channel']) assert.ok(canvasMenuHtml.includes(label), label);
// Add an agent lives in the + menu, not the overflow menu.
assert.doesNotMatch(canvasMenuHtml, /Add an agent/);
assert.match(navHtml, /aria-label="Add agent, workspace or room"[^>]*data-tour="hire"/);
const plusMenuHtml = navHtml.slice(navHtml.indexOf('data-tour="hire"')).split('</details>')[0]!;
for (const url of ['/w/ws1/connect', '/w/ws1?workspace=new', '/rooms/new']) assert.ok(plusMenuHtml.includes(`href="${url}"`), url);
assert.doesNotMatch(workspaceMenuHtml, /New workspace|New shared room/);
assert.match(workspaceMenuHtml, /<div class="sticky [^"]*">[\s\S]*?\?panel=workspace/, 'Workspace settings footer stays pinned');
assert.ok(navHtml.indexOf('data-tour="hire"') < navHtml.indexOf('aria-label="Canvas actions"'));
assert.doesNotMatch(canvasMenuHtml, /Plan and billing|Invite links|Workspace settings|New workspace/);
assert.doesNotMatch(accountMenuHtml, /Connected apps|Skills &amp; processes|Triggers/);
const searchContents = navHtml.match(/<button[^>]*data-tour="search"[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? '';
assert.doesNotMatch(searchContents, /Search or jump/);
assert.match(searchContents, /<kbd[^>]*>⌘K<\/kbd>/);
assert.match(searchContents, /data-attention-count/);

// First run with joinable channels: the Join cards lay out in a 3-wide grid, and the welcome panel's overlay lets
// clicks through to them (the wrapper is pointer-events-none, only the panel itself takes clicks).
const joinables = joinBoxes([], ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id })));
assert.deepEqual(joinables[3]!.canvas, { x: 40, y: 360, w: 580, h: 260 });
const welcomeHtml = renderToStaticMarkup(createElement(EmptyCanvasCard, { ws: 'ws1', me: { id: 'me', name: 'Dana' }, hasAgents: false, canJoin: true, onCreateTeam: noop }));
assert.match(welcomeHtml, /Join one below/);
assert.match(welcomeHtml, /class="pointer-events-auto /);
assert.match(readFileSync(path.join(import.meta.dirname, '../../components/CrewCanvas.tsx'), 'utf8'), /ref=\{placeJoinCards\} className=\{`pointer-events-none absolute inset-0/);
