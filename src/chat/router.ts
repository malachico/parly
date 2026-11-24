import { generate } from '../lib/vertex.js';

/** An agent a channel post could be for: what the router reads to choose. */
interface RouteCandidate {
  id: string;
  name: string;
  description?: string;
  role?: string;
}

/**
 * Which of `candidates` a channel post (that names none of them) is for: their ids, or none. `undefined` when it can't
 * tell (an error, no answer in time): then everyone is woken, as without a router.
 */
export type Route = (text: string, candidates: RouteCandidate[], from?: { name: string; agent: boolean }, recent?: { name: string; text: string }[]) => Promise<string[] | undefined>;

/**
 * A router on Vertex's Flash model (the hub's own account, so no new key): a cheap call that reads the post and the
 * agents' names, roles and jobs, instead of every agent spending a model call to pass.
 * ponytail: Flash until Jev (TypeSafe's decision model) has access; same `Route`, swap the call.
 */
export function vertexRouter(opts: { project: string; location: string; model: string; accessToken?: () => Promise<string>; fetchImpl?: typeof fetch; timeoutMs?: number }): Route {
  return async (text, candidates, from, recent) => {
    const prompt = routePrompt(text, candidates, from, recent);
    const started = Date.now();
    try {
      const out = await generate({
        project: opts.project,
        location: opts.location,
        model: opts.model,
        prompt,
        // A pick, not an essay: little thinking (this is a step before anyone answers).
        thinkingLevel: 'low',
        schema: { type: 'OBJECT', properties: { agents: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['agents'] },
        timeoutMs: opts.timeoutMs ?? 2000,
        accessToken: opts.accessToken,
        fetchImpl: opts.fetchImpl,
      });
      if (!out.ok) {
        console.error(`channel route: ${opts.model} answered HTTP ${out.status} in ${Date.now() - started}ms`);
        return undefined;
      }
      const parsed = JSON.parse(out.text || '') as { agents?: unknown };
      if (!Array.isArray(parsed.agents)) return undefined;
      const known = new Set(candidates.map((c) => c.id));
      const picked = parsed.agents.filter((id): id is string => typeof id === 'string' && known.has(id));
      logPick(opts.model, picked, candidates, started, from);
      return picked;
    } catch (err) {
      console.error(`channel route: no pick in ${Date.now() - started}ms (${(err as Error).name}), everyone wakes`);
      return undefined;
    }
  };
}

/** The post, the agents and the conversation before it: what a router reads. */
function routePrompt(text: string, candidates: RouteCandidate[], from?: { name: string; agent: boolean }, recent?: { name: string; text: string }[]): string {
  const list = candidates.map((c) => `- ${c.id}: ${c.name}${c.role ? ` (role here: ${c.role})` : ''}${c.description ? `. ${c.description.slice(0, 200)}` : ''}`).join('\n');
  return [
    'A message was posted in a team chat (or a thread there) without naming anyone. These AI agents are in the channel:',
    list,
    '',
    "Which of them should answer it? Usually one: the one whose job or role it is, or who it's clearly meant for. Pick more only when each has its own part to do (they answer at the same time, so two for the same thing repeat each other). A short answer (\"2\", \"yes\") to an agent's question is for that agent. Pick none if it's small talk, thanks, or for the people. Answer with their ids.",
    '',
    // An agent's message is mostly an answer: it's for another agent only when it hands them something or asks them.
    ...(from?.agent ? [`It was written by ${from.name}, one of the AI agents here. Pick an agent only if this asks it something or hands it work; an answer, an update or thanks is for nobody.`] : []),
    // ponytail: the last few messages, each cut short; enough to see who asked what was answered.
    ...(recent?.length ? ['The conversation just before it (oldest first):', ...recent.map((m) => `- ${m.name}: ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`), ''] : []),
    `Message: ${text.slice(0, 2000)}`,
  ].join('\n');
}

function logPick(model: string, picked: string[], candidates: RouteCandidate[], started: number, from?: { agent: boolean }, scores?: (number | undefined)[]) {
  // ponytail: one log line per pick, to read the real latency and choices in prod; drop once it's settled.
  // Who, not what was said: the post's text stays out of the logs. The sender's kind and each score tell a dropped
  // handoff from a correctly ignored update.
  const names = picked.map((id) => candidates.find((c) => c.id === id)!.name);
  const list = candidates.map((c, i) => (scores ? `${c.name} ${scores[i]?.toFixed(2) ?? '?'}` : c.name)).join(', ');
  console.log(`channel route (${model}): [${names.join(', ')}] of ${candidates.length} (${list}) from ${from?.agent ? 'agent' : 'person'} in ${Date.now() - started}ms`);
}

/**
 * A router on Gemini's Decisions API (gemini-decision-1, AI Studio key, no output tokens): one yes/no question per
 * agent in one request, so a post can wake none, one or several. An agent wakes when P(yes) >= `threshold`.
 */
export function decisionsRouter(opts: { apiKey: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number; threshold?: number }): Route {
  return async (text, candidates, from, recent) => {
    const started = Date.now();
    try {
      // Keys must match [A-Za-z0-9_-]{1,64}; agent ids may not, so ask by position.
      const questions = Object.fromEntries(candidates.map((c, i) => [`a${i}`, { type: 'noul', instructions: `Should ${c.name} (id ${c.id}) answer this message?` }]));
      const res = await (opts.fetchImpl ?? fetch)('https://generativelanguage.googleapis.com/v1beta/decisions', {
        method: 'POST',
        headers: { 'x-goog-api-key': opts.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: opts.model, input: routePrompt(text, candidates, from, recent), questions }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      });
      if (!res.ok) {
        console.error(`channel route: ${opts.model} answered HTTP ${res.status} in ${Date.now() - started}ms`);
        return undefined;
      }
      const { answers } = (await res.json()) as { answers?: Record<string, { noul?: unknown }> };
      if (!answers) return undefined;
      const scores = candidates.map((_, i) => {
        const p = answers[`a${i}`]?.noul;
        return typeof p === 'number' ? p : undefined;
      });
      // ponytail: a flat threshold; tune it per sender kind once the logged scores show the spread.
      let picked = candidates.filter((_, i) => (scores[i] ?? 0) >= (opts.threshold ?? 0.5)).map((c) => c.id);
      // A person is never left unheard: below the threshold, the likeliest agent beats the hub's own-agent guess.
      if (!picked.length && !from?.agent) {
        const best = scores.reduce<number>((b, p, i) => (p !== undefined && p > (scores[b] ?? -1) ? i : b), -1);
        if (best >= 0) picked = [candidates[best]!.id];
      }
      logPick(opts.model, picked, candidates, started, from, scores);
      return picked;
    } catch (err) {
      console.error(`channel route: no pick in ${Date.now() - started}ms (${(err as Error).name}), everyone wakes`);
      return undefined;
    }
  };
}
