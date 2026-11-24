import express, { Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { agentOf, requireAgent } from '../lib/auth.js';
import { hasGitHubToolkit } from '../hub/cloudAgent.js';
import { HubError } from '../lib/errors.js';
import { channelView } from '../lib/present.js';
import { timingSafeEqual } from 'node:crypto';
import { retryBilling } from './companies.js';
import { hookText, json, publicMessageView, publicPeople, str, webhookView } from './helpers.js';

/** The scheduler tick, Slack, webhooks (incoming and managed), public threads. */
export function integrationsRoutes(router: Router, hub: HubService): void {
  const connectedTelegram = () => {
    if (!hub.telegram) throw new HubError('not_found', "This hub isn't connected to Telegram");
    return hub.telegram;
  };
  const connectedSlack = () => {
    if (!hub.slackOAuth) throw new HubError('not_found', "This hub isn't connected to Slack");
    return hub.slackOAuth;
  };
  const connectedSlackBridge = () => {
    if (!hub.slack) throw new HubError('not_found', "This hub isn't connected to Slack");
    return hub.slack;
  };

  /**
   * A sandboxed agent (`tools.act` + the `github` toolkit) mints a short-lived, repo-scoped GitHub installation
   * token to `git clone`/`push` via Parly's App — so a hosted computer agent does the full code loop without a
   * standing PAT. Uses the install mapped to the agent's owner (github_installs), contents+pull_requests write; ~1h TTL.
   * Pair with a pod-side git credential helper that calls this per-op so nothing is ever stored in the sandbox.
   * Bots only (endpoint/mailbox, e.g. hired Compis and external agents like Cline); a human caller is refused —
   * people use their own git credentials, not Parly's App.
   */
  router.post(
    '/github/token',
    requireAgent,
    json(async (req) => {
      const agent = agentOf(req)!;
      if (!hub.github) throw new HubError('not_found', "This hub isn't connected to GitHub");
      if (agent.kind === 'human') throw new HubError('forbidden', 'This endpoint is for agents; people use their own git credentials');
      if (!agent.tools?.act) throw new HubError('forbidden', 'Only an agent allowed to act may mint a GitHub token');
      if (!hasGitHubToolkit(agent)) throw new HubError('forbidden', 'Turn on the GitHub toolkit for this agent first');
      // Only the install mapped to this agent's owner: never another account's.
      const install = await hub.githubInstalls!.forOwner(agent.ownerId ?? agent.id);
      if (!install) throw new HubError('not_found', "Your owner hasn't connected GitHub to Parly yet");
      if (install.repositorySelection === 'selected' && !install.repos.length) throw new HubError('forbidden', 'No repositories are selected for this GitHub installation');
      return hub.github.scopedToken(install.installationId, {
        repositories: install.repos,
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      });
    }),
  );

  /**
   * Starts installing Parly's GitHub App for the signed-in person (single-use 10-minute `state`, like Slack).
   * Browser: 302 to GitHub; `?format=json` or Accept: json → `{url, state}`.
   */
  router.get('/github/install', requireAgent, (req, res, next) => {
    if (!hub.githubInstallOAuth) return next(new HubError('not_found', "This hub isn't connected to GitHub"));
    hub.githubInstallOAuth
      .startInstall(agentOf(req)!)
      .then(({ url, state }) => {
        if (req.query.format === 'json' || req.accepts(['html', 'json']) === 'json') res.json({ url, state });
        else res.redirect(302, url);
      }, next);
  });

  router.post(
    '/github/install',
    requireAgent,
    json(async (req) => {
      if (!hub.githubInstallOAuth) throw new HubError('not_found', "This hub isn't connected to GitHub");
      return hub.githubInstallOAuth.startInstall(agentOf(req)!);
    }),
  );

  /**
   * GitHub App setup/callback URL: GitHub's browser redirect carries no Parly session, so forward the query to the
   * `/github/installed` web page, which posts it to `POST /github/oauth/complete` with the signed-in person's token.
   */
  router.get('/github/callback', (req, res, next) => {
    if (!hub.githubInstallOAuth) return next(new HubError('not_found', "This hub isn't connected to GitHub"));
    const url = new URL(hub.githubInstallOAuth.installedPageUrl);
    for (const k of ['code', 'state', 'installation_id', 'setup_action', 'error', 'error_description']) {
      const v = str(req.query[k]);
      if (v) url.searchParams.set(k, v);
    }
    res.redirect(302, url.toString());
  });

  /**
   * Completes a GitHub App install for the signed-in person who started it: spends `state`, exchanges `code`,
   * verifies `installation_id` against `GET /user/installations`, saves the install, returns `{redirectUrl}`.
   */
  router.post(
    '/github/oauth/complete',
    requireAgent,
    json(async (req) => {
      if (!hub.githubInstallOAuth) throw new HubError('not_found', "This hub isn't connected to GitHub");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const out = await hub.githubInstallOAuth.handleCallback(agentOf(req)!, {
        code: str(body.code),
        state: str(body.state),
        installation_id: str(body.installation_id),
        setup_action: str(body.setup_action),
        error: str(body.error),
        error_description: str(body.error_description),
      });
      return { ok: true, redirectUrl: out.redirectUrl, ...(out.install ? { installed: true } : {}) };
    }),
  );

  /** Starts installing the Parly Slack app in a Slack workspace for `workspace` (single-use 10-minute `state`). */
  router.get('/slack/install', requireAgent, (req, res, next) => {
    if (!hub.slackOAuth) return next(new HubError('not_found', "This hub isn't connected to Slack"));
    hub.slackOAuth
      .startInstall(agentOf(req)!, str(req.query.workspace) ?? '')
      .then(({ url, state }) => {
        if (req.query.format === 'json' || req.accepts(['html', 'json']) === 'json') res.json({ url, state });
        else res.redirect(302, url);
      }, next);
  });

  router.post(
    '/slack/install',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return connectedSlack().startInstall(agentOf(req)!, str(body.workspaceId) ?? str(body.workspace) ?? '');
    }),
  );

  /**
   * Slack OAuth v2 completion: the `/slack/installed` web page posts `{code, state, error?}` with the signed-in
   * person's bearer token so `completeInstall` can verify `caller.id === state.ownerId` before exchanging `code`.
   */
  router.post(
    '/slack/oauth/complete',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const out = await connectedSlack().completeInstall(agentOf(req)!, {
        code: str(body.code),
        state: str(body.state),
        error: str(body.error),
      });
      return {
        ok: true,
        workspaceId: out.workspaceId,
        redirectUrl: out.redirectUrl,
        ...(out.install
          ? {
              install: {
                teamId: out.install.teamId,
                teamName: out.install.teamName,
                workspaceId: out.install.workspaceId,
                ...(out.install.sideId ? { sideId: out.install.sideId } : {}),
              },
            }
          : {}),
      };
    }),
  );

  /** Workspace Slack installation status (and with `?channels=1`, the Slack channels the bot is in). Side-scoped in rooms. */
  router.get(
    '/workspaces/:id/slack',
    requireAgent,
    json(async (req) => {
      if (!hub.slackOAuth) {
        await hub.registry.requireWorkspaceMembership(agentOf(req)!, String(req.params.id));
        return { configured: false, canManage: false };
      }
      return hub.slackOAuth.workspaceStatus(agentOf(req)!, String(req.params.id), req.query.channels === '1');
    }),
  );

  /** Links a Parly channel to a Slack channel (`{channelId, cornerChannelId?, teamId?}`). In a room, links both shared + corner for the side. */
  router.post(
    '/channels/:id/slack',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return connectedSlack().linkChannel(agentOf(req)!, String(req.params.id), {
        channelId: str(body.channelId),
        cornerChannelId: str(body.cornerChannelId),
        teamId: str(body.teamId),
      });
    }),
  );

  /** Unlinks a Parly channel from Slack (in a room, unlinks the caller's side from shared + corner). */
  router.delete(
    '/channels/:id/slack',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return connectedSlack().unlinkChannel(agentOf(req)!, String(req.params.id), {
        channelId: str(body.channelId) ?? str(req.query.channelId),
        teamId: str(body.teamId) ?? str(req.query.teamId),
      });
    }),
  );

  /** Workspace Telegram status (connected supergroups and channel-to-topic mappings). */
  router.get(
    '/workspaces/:id/telegram',
    requireAgent,
    json(async (req) => {
      if (!hub.telegram) {
        await hub.registry.requireWorkspaceMembership(agentOf(req)!, String(req.params.id));
        return { configured: false, canManage: false, chats: [], links: [] };
      }
      return hub.telegram.workspaceStatus(agentOf(req)!, String(req.params.id));
    }),
  );

  /** Connects a Telegram supergroup (`{chatId, title?}`) to a Parly workspace. */
  router.post(
    '/workspaces/:id/telegram',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return connectedTelegram().connectWorkspaceForOwner(agentOf(req)!, String(req.params.id), {
        chatId: body.chatId !== undefined ? String(body.chatId) : undefined,
        title: str(body.title),
      });
    }),
  );

  /** Disconnects a Telegram supergroup (`{chatId?}`) from a Parly workspace. */
  router.delete(
    '/workspaces/:id/telegram',
    requireAgent,
    json(async (req) => {
      const telegram = connectedTelegram();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawChat = body.chatId !== undefined ? String(body.chatId) : str(req.query.chatId);
      return telegram.disconnectWorkspaceForOwner(agentOf(req)!, String(req.params.id), {
        chatId: rawChat,
      });
    }),
  );

  /** Links a Parly channel to a Telegram chat (`{chatId?, topicId?}`). */
  router.post(
    '/channels/:id/telegram',
    requireAgent,
    json(async (req) => {
      const telegram = connectedTelegram();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawChat = body.chatId !== undefined ? String(body.chatId) : undefined;
      const rawTopic = body.topicId !== undefined && body.topicId !== null ? (body.topicId as number | string) : undefined;
      return telegram.linkChannelForOwner(agentOf(req)!, String(req.params.id), {
        chatId: rawChat,
        topicId: rawTopic,
      });
    }),
  );

  /** Unlinks a Parly channel from Telegram (`{chatId?, topicId?}`). */
  router.delete(
    '/channels/:id/telegram',
    requireAgent,
    json(async (req) => {
      const telegram = connectedTelegram();
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawChat = body.chatId !== undefined ? String(body.chatId) : str(req.query.chatId);
      const rawTopic =
        body.topicId !== undefined && body.topicId !== null
          ? (body.topicId as number | string)
          : str(req.query.topicId);
      return telegram.unlinkChannelForOwner(agentOf(req)!, String(req.params.id), {
        chatId: rawChat,
        topicId: rawTopic,
      });
    }),
  );

  /** Issues a one-time 10-minute code for the caller to confirm via DM `/start <code>` to the Telegram bot. */
  router.post(
    '/telegram/link/code',
    requireAgent,
    json(async (req) => {
      return connectedTelegram().issueLinkCode(agentOf(req)!);
    }),
  );

  /** Inspects a bot-issued one-time Telegram identity link code (`?code=`) before the caller approves it. */
  router.get(
    '/telegram/link',
    requireAgent,
    json(async (req) => {
      return connectedTelegram().inspectLinkCode(agentOf(req)!, str(req.query.code) ?? '');
    }),
  );

  /** Approves a bot-issued one-time Telegram identity link code (`{code}`), binding the Telegram user to the caller. */
  router.post(
    '/telegram/link',
    requireAgent,
    json(async (req) => {
      return connectedTelegram().link(agentOf(req)!, String((req.body ?? {}).code ?? ''));
    }),
  );

  /** Lists the caller's linked Telegram accounts (for account settings), and unlinking (`DELETE /me/telegram/:telegramUserId`). */
  router.get(
    '/me/telegram',
    requireAgent,
    json(async (req) => (hub.telegram ? hub.telegram.identitiesOf(agentOf(req)!) : [])),
  );

  router.delete(
    '/me/telegram',
    requireAgent,
    json(async (req) => {
      await connectedTelegram().unlinkMyIdentity(agentOf(req)!, str((req.body ?? {}).telegramUserId) ?? str(req.query.telegramUserId));
      return { ok: true };
    }),
  );

  router.delete(
    '/me/telegram/:telegramUserId',
    requireAgent,
    json(async (req) => {
      await connectedTelegram().unlinkMyIdentity(agentOf(req)!, String(req.params.telegramUserId));
      return { ok: true };
    }),
  );

  /** Inspects a one-time Slack identity link code (`?code=`) before the person approves it. */
  router.get(
    '/slack/link',
    requireAgent,
    json(async (req) => {
      return connectedSlack().inspectLinkCode(agentOf(req)!, str(req.query.code) ?? '');
    }),
  );

  /** A person links their Slack account: `{code}`, from the one-time link the Parly Slack app sent them in Slack. */
  router.post(
    '/slack/link',
    requireAgent,
    json(async (req) => {
      return connectedSlackBridge().link(agentOf(req)!, String((req.body ?? {}).code ?? ''));
    }),
  );

  /** The caller's linked Slack accounts (for account settings), and unlinking one (`DELETE /me/slack/:teamId`). */
  router.get(
    '/me/slack',
    requireAgent,
    json(async (req) => (hub.slackOAuth ? hub.slackOAuth.identitiesOf(agentOf(req)!) : [])),
  );

  router.delete(
    '/me/slack/:teamId',
    requireAgent,
    json(async (req) => {
      await connectedSlack().unlinkMyIdentity(agentOf(req)!, String(req.params.teamId));
      return { ok: true };
    }),
  );

  /**
   * The scheduler job, every minute: posts what's due, and wakes the agents whose wake-ups a sleeping instance missed.
   * `X-Tick-Secret` must match TICK_SECRET (no secret, no /tick).
   */
  router.post(
    '/tick',
    json(async (req) => {
      const secret = req.app.locals.tickSecret as string | undefined;
      const given = req.get('x-tick-secret') ?? '';
      if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) throw new HubError('not_found', 'Not found');
      const [ran, woken, slept, slack, telegram, appEvents] = await Promise.all([
        hub.scheduleService.runSchedules(),
        hub.wakeService.wakeSweep(),
        hub.computers.sweep(),
        hub.slack?.sweep() ?? 0,
        hub.telegram?.sweep() ?? 0,
        hub.appEvents.sweep(),
        retryBilling(hub),
      ]);
      return { ran, woken, slept, appEvents, ...(hub.slack ? { slack } : {}), ...(hub.telegram ? { telegram } : {}) };
    }),
  );

  /**
   * A member makes an incoming webhook for a channel: `{name?}`. Not an agent: what services post to its URL goes in
   * as the member, marked 🪝 and its name. The token, returned once, goes in the URL: POST /hooks/:channelId/:token.
   */
  router.post(
    '/channels/:id/webhooks',
    requireAgent,
    json(async (req, res) => {
      const { webhook, token } = await hub.createWebhook(agentOf(req)!, String(req.params.id), str((req.body ?? {}).name));
      res.status(201);
      return { webhook: webhookView(webhook), token };
    }),
  );
  router.get(
    '/channels/:id/webhooks',
    requireAgent,
    json(async (req) => (await hub.channelWebhooks(agentOf(req)!, String(req.params.id))).map(webhookView)),
  );
  /** Whoever made it or a channel owner deletes a webhook: its URL stops working. */
  router.delete(
    '/webhooks/:id',
    requireAgent,
    json(async (req) => (await hub.deleteWebhook(agentOf(req)!, String(req.params.id)), { ok: true })),
  );

  /** A file attached to what a public channel shows, for anyone: a redirect to a short-lived link (`?download=1` to save it). */
  router.get('/public/channels/:id/files/:file', (req, res, next) => {
    (async () => {
      const file = await hub.publicFileForDownload(String(req.params.id), String(req.params.file));
      res.redirect(302, await hub.files.downloadUrl(file, { attachment: Boolean(req.query.download) }));
    })().catch(next);
  });

  /**
   * Thread settings:
   * - `{public: true | false}` (channel or workspace owner): lets anyone read this post's thread (/p/<channel>?thread=<post>), or stops it.
   * - `{done: true | false}` (thread starter or channel/workspace owner): marks the thread as done (stops work, hides from open feed) or reopens it.
   */
  router.patch(
    '/channels/:id/threads/:post',
    requireAgent,
    json(async (req) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hasPublic = typeof body.public === 'boolean';
      const hasDone = typeof body.done === 'boolean';
      if (!hasPublic && !hasDone) throw new HubError('invalid', 'Give public: true or false, or done: true or false');
      const caller = agentOf(req)!;
      const channelId = String(req.params.id);
      const post = String(req.params.post);
      let channel = hasPublic ? await hub.setThreadPublic(caller, channelId, post, body.public as boolean) : undefined;
      if (hasDone) channel = await hub.setThreadDone(caller, channelId, post, body.done as boolean);
      return channelView(channel!, caller);
    }),
  );

  /** A thread anyone can read: shared on its own, or in a public channel with its post made after it went public. */
  router.get(
    '/public/channels/:id/threads/:post',
    json(async (req) => {
      const t = await hub.chat.publicThread(String(req.params.id), String(req.params.post));
      const all = [t.post, ...t.replies];
      return { channel: { id: t.channel.id, name: t.channel.name }, post: publicMessageView(t.post), replies: t.replies.map(publicMessageView), people: await publicPeople(hub, all.map((m) => m.fromId)) };
    }),
  );

  /**
   * Incoming webhook: a service that can't send headers (GitHub, Vercel, Sentry, anything that posts to a Slack
   * webhook) posts into a channel as a bot, with the bot's token in the URL. Make a bot, add it to the channel,
   * and give the service `<hub>/hooks/<channelId>/<bot token>` (`?thread=<post id>` posts in that thread). Slack's `{text}` (or attachments/blocks), GitHub's
   * events, or any JSON; `@Name` in the text wakes that member like any channel post.
   */
  router.post(
    '/hooks/:channel/:token',
    express.urlencoded({ extended: false, limit: '1mb' }),
    json(async (req, res) => {
      let body = req.body as unknown;
      // GitHub's and Slack's form encoding put the JSON in a `payload` field.
      const payload = (body as Record<string, unknown>)?.payload;
      if (typeof payload === 'string') {
        try {
          body = JSON.parse(payload);
        } catch {
          throw new HubError('invalid', 'The form field "payload" is not JSON');
        }
      }
      const text = hookText(body, req.get('x-github-event'));
      const channel = String(req.params.channel);
      const thread = str(req.query.thread);
      const token = String(req.params.token);
      // A channel's webhook (Automations), or else a bot's own token.
      const hook = await hub.webhooks.byToken(token);
      const sent = hook
        ? await hub.postWebhook(hook, channel, text, thread)
        : await (async () => {
            const bot = await hub.registry.authenticate(token);
            // A person's token never goes in a URL: only bots post this way.
            if (!bot || bot.kind === 'human') throw new HubError('unauthorized', 'Unknown webhook: its URL is wrong or it was deleted');
            if (bot.webhookChannel && bot.webhookChannel !== channel) throw new HubError('forbidden', 'This webhook posts into another channel');
            return hub.send(bot, { channel, ...(thread ? { thread } : {}) }, await hub.parts(bot, text, undefined, undefined));
          })();
      res.status(201);
      return { ok: true, id: sent.message.id };
    }),
  );
}
