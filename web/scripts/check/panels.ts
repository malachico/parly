import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelPanel } from '../../components/ChannelPanel';
import { WorkspacePanel } from '../../components/WorkspacePanel';
import assert from 'node:assert/strict';

// ChannelPanel tabs: Members, Skills (Processes & Skills grouped separately), Automations (schedules + webhooks), Settings (Slack + Telegram + channel settings).
export const panelHtml = renderToStaticMarkup(
  createElement(ChannelPanel, {
    initialTab: 'settings',
    workspaceId: 'ws1',
    channel: {
      id: 'ch1',
      workspaceId: 'ws1',
      name: 'dev',
      owner: true,
      owners: ['me'],
      open: true,
      public: true,
      slack: [{ teamId: 'T1', channelId: 'C1' }],
      telegram: [{ chatId: '-100123456', topicId: 42 }],
    },
    slack: {
      canManage: true,
      configured: true,
      install: { teamId: 'T1', teamName: 'Acme', at: '2026-10-08T00:00:00Z' },
      channels: [{ id: 'C1', name: 'dev', isPrivate: false }],
    },
    meId: 'me',
    members: [{ id: 'me', name: 'Me', description: '', kind: 'human', public: true, skills: [], workspaces: [], channels: [], lastSeen: '2026-10-08T00:00:00Z' }],
    candidates: [],
    closeHref: '/w/ws1/c/channel%3Ach1',
    schedules: [],
    webhooks: [{ id: 'wh1', channelId: 'ch1', name: 'GitHub', ownerId: 'me', createdAt: '2026-10-08T00:00:00Z' }],
    skills: [
      {
        skill: { id: 'p1', name: 'feature-dev', description: 'Team process', type: 'process' },
        source: 'direct',
        enabled: true,
      },
      {
        skill: { id: 'builtin:skill-writer', name: 'skill-writer', description: 'Write skills', type: 'skill' },
        source: 'builtin',
        enabled: true,
      },
    ],
    librarySkills: [],
  }),
);
const tabPanels = panelHtml.split('role="tabpanel"').slice(1);
assert.equal(tabPanels.length, 4, 'Expected 4 channel panel tabs: Members, Skills, Automations, Settings');
const [, skillsPanel, automationsPanel, settingsPanel] = tabPanels;
// Skills tab holds Skills & Processes (with Processes and Skills grouped), not webhooks or Slack/Telegram.
assert.match(skillsPanel!, /Skills &amp; Processes/);
assert.match(skillsPanel!, /🔀 Processes/);
assert.match(skillsPanel!, /📘 Skills/);
assert.doesNotMatch(skillsPanel!, /Incoming webhooks/);
// Automations tab holds Scheduled messages and Incoming webhooks, not Skills/Processes or Slack/Telegram.
assert.match(automationsPanel!, /Scheduled messages/);
assert.match(automationsPanel!, /Incoming webhooks/);
assert.doesNotMatch(automationsPanel!, /Skills &amp; Processes/);
assert.doesNotMatch(automationsPanel!, /Bridged to Telegram|Update topic link/);
assert.doesNotMatch(automationsPanel!, /Unlink from Slack/);
// Settings tab holds lightweight per-channel Slack/Telegram mapping + status badge alongside channel settings.
assert.match(settingsPanel!, /Unlink from Slack/);
assert.match(settingsPanel!, /Bridged to Telegram · topic #42/);
assert.match(settingsPanel!, /Manage in Workspace Settings/);
assert.match(settingsPanel!, /Update topic link/);

// WorkspacePanel Integrations section holds workspace-level Slack and Telegram supergroup connections + Channel ↔ Topic mappings.
const wsHtml = renderToStaticMarkup(
  createElement(WorkspacePanel, {
    workspace: {
      id: 'ws1',
      name: 'Acme',
      owner: true,
      owners: ['me'],
      channels: [{ id: 'ch1', workspaceId: 'ws1', name: 'dev', owner: true, owners: ['me'], open: true, public: false }],
    },
    meId: 'me',
    members: [{ id: 'me', name: 'Me', description: '', kind: 'human', public: false, skills: [], workspaces: ['ws1'], channels: ['ch1'], lastSeen: '2026-10-08T00:00:00Z' }],
    invites: [],
    candidates: [],
    hasOtherWorkspace: true,
    slack: {
      canManage: true,
      configured: true,
      install: { teamId: 'T1', teamName: 'Acme Slack', at: '2026-10-08T00:00:00Z' },
    },
    telegram: {
      configured: true,
      canManage: true,
      chats: [{ chatId: '-100123456', title: 'Acme Supergroup', updatedAt: '2026-10-08T00:00:00Z' }],
      links: [{ channelId: 'ch1', channelName: 'dev', chatId: '-100123456', topicId: 42 }],
    },
    closeHref: '/w/ws1',
  }),
);
assert.match(wsHtml, /Workspace name/);
assert.match(wsHtml, /Save name/);
assert.match(wsHtml, /Integrations/);
assert.match(wsHtml, /Acme Supergroup/);
assert.match(wsHtml, /Update Telegram group/);
assert.match(wsHtml, /Channel ↔ Topic mappings/);
assert.match(wsHtml, /topic #42/);
assert.match(wsHtml, /Archive workspace/);
assert.doesNotMatch(wsHtml, />personal</);

const wsLastHtml = renderToStaticMarkup(
  createElement(WorkspacePanel, {
    workspace: {
      id: 'ws1',
      name: 'Acme',
      owner: true,
      owners: ['me'],
      channels: [],
    },
    meId: 'me',
    members: [{ id: 'me', name: 'Me', description: '', kind: 'human', public: false, skills: [], workspaces: ['ws1'], channels: [], lastSeen: '2026-10-08T00:00:00Z' }],
    invites: [],
    candidates: [],
    hasOtherWorkspace: false,
    closeHref: '/w/ws1',
  }),
);
assert.doesNotMatch(wsLastHtml, /Archive workspace/);

// Participant cap: only owners[0] (billing owner) gets Upgrade; co-owners with management rights do not.
const atCap = { count: 8, max: 8 };
const billingOwnerCapHtml = renderToStaticMarkup(
  createElement(WorkspacePanel, {
    workspace: {
      id: 'ws1',
      name: 'Acme',
      owner: true,
      owners: ['alice'],
      participants: atCap,
      channels: [],
    },
    meId: 'alice',
    members: Array.from({ length: 8 }, (_, i) => ({
      id: i === 0 ? 'alice' : `m${i}`,
      name: i === 0 ? 'Alice' : `M${i}`,
      description: '',
      kind: 'human' as const,
      public: false,
      skills: [],
      workspaces: ['ws1'],
      channels: [],
      lastSeen: '2026-10-08T00:00:00Z',
    })),
    invites: [],
    candidates: [],
    closeHref: '/w/ws1',
  }),
);
assert.match(billingOwnerCapHtml, /8\/8 participants, upgrade to add more/);
assert.match(billingOwnerCapHtml, /href="\/billing"[^>]*>Upgrade/);

const coOwnerCapHtml = renderToStaticMarkup(
  createElement(WorkspacePanel, {
    workspace: {
      id: 'ws1',
      name: 'Acme',
      owner: true,
      owners: ['alice', 'bob'],
      participants: atCap,
      channels: [],
    },
    meId: 'bob',
    members: Array.from({ length: 8 }, (_, i) => ({
      id: i === 0 ? 'alice' : i === 1 ? 'bob' : `m${i}`,
      name: i === 0 ? 'Alice' : i === 1 ? 'Bob' : `M${i}`,
      description: '',
      kind: 'human' as const,
      public: false,
      skills: [],
      workspaces: ['ws1'],
      channels: [],
      lastSeen: '2026-10-08T00:00:00Z',
    })),
    invites: [],
    candidates: [],
    closeHref: '/w/ws1',
  }),
);
assert.match(coOwnerCapHtml, /ask the workspace owner to upgrade/);
assert.doesNotMatch(coOwnerCapHtml, /href="\/billing"/);
assert.doesNotMatch(coOwnerCapHtml, /upgrade your plan/);
