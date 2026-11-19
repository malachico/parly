import type { LlmMeter } from '../llm/llm.js';
import { readBodyCapped } from '../lib/publicFetch.js';
import type { AgentRecord } from '../registry/types.js';
import { toolkitOf, type Composio } from './composio.js';

/** The same when the agent picked its fields or read a file: what it asked for, whole (a PR's patches, a file). */
export const PICKED_RESULT_MAX = 24_000;
/** A file a tool hands back as a download link (Composio's `s3url`): read in for the agent, up to this much. */
const FILE_TEXT_MAX = 100_000;
/** Fields that are noise to a model: links, ids, pictures, signatures. */
const NOISE = /(^|_)(url|urls|node_id|gravatar_id|avatar|avatar_url|_links|links|verification|signature|etag|sha256|html_url|events_url)$/i;

/**
 * Only the named fields of a result, wherever they are: a matching key keeps its value; any other object or list
 * keeps just what matches inside it. Nothing matching anywhere: the result as it was (a wrong guess costs nothing).
 */
export function pick(value: unknown, fields: string[]): unknown {
  const want = new Set(fields.map((f) => f.toLowerCase()));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const items = v.map(walk).filter((x) => x !== undefined);
      return items.length ? items : undefined;
    }
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (want.has(k.toLowerCase())) out[k] = x;
        else {
          const inner = walk(x);
          if (inner !== undefined) out[k] = inner;
        }
      }
      return Object.keys(out).length ? out : undefined;
    }
    return undefined;
  };
  return walk(value) ?? value;
}

/** The keys a result has (top level, or its first item's), to tell a model what it may ask for. */
function keysOf(value: unknown): string[] {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v || typeof v !== 'object') return [];
  const keys = Object.keys(v);
  // One level down too, where results usually wrap their list (data.items, data.commits…).
  const inner = keys.flatMap((k) => ((v as Record<string, unknown>)[k] && typeof (v as Record<string, unknown>)[k] === 'object' ? keysOf((v as Record<string, unknown>)[k]).map((x) => `${k}.${x}`) : []));
  return [...keys, ...inner].slice(0, 40);
}

/** Every string in it cut to its first line (at most 160 characters). */
function firstLinesOf(v: unknown): unknown {
  if (typeof v === 'string') {
    const line = v.split('\n', 1)[0]!;
    return line.length > 160 ? `${line.slice(0, 160)}…` : line + (v.includes('\n') ? ' …' : '');
  }
  if (Array.isArray(v)) return v.map(firstLinesOf);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, firstLinesOf(x)]));
  return v;
}

/** A tool result made small: noise fields and empties dropped, long strings and lists cut. */
export function compact(value: unknown, depth = 0, picked = false): unknown {
  const max = picked ? PICKED_RESULT_MAX : 1500;
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) {
    // In a long list, text is cut to its first line: a commit's or issue's title, not its body. Not when the agent
    // picked the fields it wants (run_tool's `fields`, e.g. each file's patch): those it gets whole, up to the caps.
    const firstLines = value.length > 5 && !picked;
    const maxItems = picked ? 200 : 40;
    const items = value.slice(0, maxItems).map((v) => (firstLines ? firstLinesOf(compact(v, depth + 1, picked)) : compact(v, depth + 1, picked)));
    return value.length > maxItems ? [...items, `(${value.length - maxItems} more not shown)`] : items;
  }
  if (value && typeof value === 'object') {
    if (depth > 6) return '(nested)';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (NOISE.test(k) || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
      const c = compact(v, depth + 1, picked);
      if (c && typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length) continue;
      out[k] = c;
    }
    return out;
  }
  return value;
}

/** True when `github` is enabled in the agent's `tools.toolkits`. */
export function hasGitHubToolkit(agent: Pick<AgentRecord, 'tools'>): boolean {
  return (agent.tools?.toolkits ?? []).some((t) => t.toLowerCase() === 'github');
}

/** The apps an agent may use: turned on for it by its owner, with a working account of theirs (Composio's github is excluded; GitHub uses Parly's native App). */
export async function appsOf(composio: Composio | undefined, agent: AgentRecord): Promise<string[]> {
  const toolkits = (agent.tools?.toolkits ?? []).filter((t) => t.toLowerCase() !== 'github');
  if (!composio || !toolkits.length) return [];
  try {
    const live = new Set((await composio.accounts(agent.ownerId ?? agent.id)).filter((a) => a.status === 'ACTIVE').map((a) => a.toolkit));
    return toolkits.filter((t) => live.has(t));
  } catch (err) {
    // Composio unreachable: the agent answers without tools rather than not at all.
    console.error(`composio apps for ${agent.id}:`, err);
    return [];
  }
}

/**
 * find_tools or run_tool: find tools in its apps, or run one of them as its owner (a write only when it may act). With
 * `credits`, a run that works costs `payer` (defaults to `owner`) 1 credit, and none runs once that plan is spent.
 * Composio always executes as `owner` (connected accounts); `payer` is only for metering.
 */
export async function useAppTool(
  composio: Composio | undefined,
  owner: string,
  apps: string[],
  act: boolean,
  name: string,
  args: Record<string, unknown>,
  credits?: Pick<LlmMeter, 'hasCredits' | 'charge'>,
  payer = owner,
): Promise<unknown> {
  if (!composio) return { ok: false, error: `No function ${name}` };
  if (name === 'find_tools') {
    const wanted = typeof args.app === 'string' ? args.app.toLowerCase() : undefined;
    const app = wanted ? apps.find((a) => a === wanted) : undefined;
    if (args.app && !app) return { ok: false, error: `You can't use ${String(args.app)}. Your apps: ${apps.join(', ')}` };
    // One search, or several at once (each its own search; one list, each tool once).
    const queries = Array.isArray(args.queries) ? args.queries.filter((q): q is string => typeof q === 'string' && !!q.trim()).slice(0, 5) : [];
    const found = await Promise.all((queries.length ? queries : [String(args.query ?? '')]).map((q) => composio.findTools(app ? [app] : apps, q, { act })));
    const tools = [...new Map(found.flat().map((t) => [t.slug, t])).values()];
    return { ok: true, tools: tools.map((t) => ({ tool: t.slug, app: t.toolkit, does: t.description, arguments: t.parameters, ...(t.readOnly ? {} : { writes: true }) })) };
  }
  if (name === 'run_tool') {
    // Models sometimes name the tool under another key; with none at all, say what's missing.
    const slug = String(args.tool ?? args.slug ?? args.tool_slug ?? args.name ?? '').trim();
    if (!slug) return { ok: false, error: 'run_tool needs `tool`: the name find_tools gave, e.g. "GITHUB_LIST_PULL_REQUESTS_FILES".' };
    const app = toolkitOf(slug, apps);
    if (!app) return { ok: false, error: `${slug} isn't a tool of your apps (${apps.join(', ')}). Use find_tools first.` };
    const tool = await composio.tool(slug, app);
    if (!tool) return { ok: false, error: `No tool ${slug}` };
    if (!tool.readOnly && !act) return { ok: false, error: 'This tool changes things, and your owner lets you only read. Write out what you would do and ask them.' };
    if (credits && !(await credits.hasCredits(payer)))
      return { ok: false, error: "Your owner's Parly credits for this month are used up, so apps are paused until they upgrade, top up or the month renews." };
    const out = await composio.execute(owner, slug, (args.arguments as Record<string, unknown> | undefined) ?? {});
    if (credits && out.ok) await credits.charge(payer, 1);
    const files: Attachment[] = [];
    if (out.ok && (await readFiles(out.data, files))) return { ...out, whole: true, ...(files.length ? { files } : {}) };
    const fields = Array.isArray(args.fields) ? args.fields.filter((f): f is string => typeof f === 'string' && !!f) : [];
    if (!fields.length || !out.ok) return out;
    const picked = pick(out.data, fields);
    // A guess that matches nothing: the whole (compacted) result, and what it could have asked for.
    return picked === out.data ? { ...out, note: `No field matched ${JSON.stringify(fields)}. Fields here: ${keysOf(out.data).join(', ')}` } : { ...out, data: picked };
  }
  return { ok: false, error: `No function ${name}` };
}

/** A PDF or picture the agent is shown (Gemini reads them), each up to this size; most this many per tool call. */
const FILE_BYTES_MAX = 5_000_000;
const FILES_PER_CALL = 3;
/** What the model is shown alongside a tool's result: a PDF or a picture, as data. */
export type Attachment = { inlineData: { mimeType: string; data: string } };

/** A PDF's or picture's type, from its first bytes (a link's content type is unreliable). */
function viewableType(b: Uint8Array): string | undefined {
  const starts = (sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
  if (starts([0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (starts([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return undefined;
}

/**
 * A file in a tool's result comes as a download link the agent can't open (`{name, mimetype, s3url}`, e.g. GitHub's raw
 * file content, a Drive file, a mail attachment). Read in place of the link: text as `text`; a PDF or a picture into
 * `files`, for the model to see, its place marked `shown`. Anything else (a .docx, too big) stays a link. True if any was read.
 */
export async function readFiles(value: unknown, files: Attachment[] = [], depth = 0): Promise<boolean> {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  const file = value as { s3url?: unknown; text?: unknown; shown?: unknown };
  if (typeof file.s3url === 'string' && isFileHost(file.s3url)) {
    const res = await fetch(file.s3url, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!res?.ok || Number(res.headers.get('content-length') ?? 0) > FILE_BYTES_MAX) return false;
    const { bytes, truncated } = await readBodyCapped(res, FILE_BYTES_MAX);
    if (truncated) return false;
    const type = viewableType(bytes);
    if (type) {
      if (files.length >= FILES_PER_CALL) return false;
      files.push({ inlineData: { mimeType: type, data: Buffer.from(bytes).toString('base64') } });
      file.shown = `${type === 'application/pdf' ? 'PDF' : 'picture'} ${files.length}, attached to this result`;
    } else {
      // Text is what has no NUL bytes (types are unreliable: a .ts file is often octet-stream).
      if (bytes.length > 5 * FILE_TEXT_MAX || bytes.includes(0)) return false;
      const text = new TextDecoder().decode(bytes);
      file.text = text.length > FILE_TEXT_MAX ? `${text.slice(0, FILE_TEXT_MAX)}…` : text;
    }
    delete file.s3url;
    return true;
  }
  let any = false;
  for (const v of Object.values(value)) if (await readFiles(v, files, depth + 1)) any = true;
  return any;
}

/** Composio's file links are S3 buckets or Cloudflare R2's; nothing else is fetched (a result can carry any URL, and other AWS hosts are anyone's). */
function isFileHost(url: string): boolean {
  try {
    const u = new URL(url);
    // Virtual-hosted, path-style, and dualstack S3 hostnames only — not arbitrary *.amazonaws.com (SSRF).
    const s3 = /^(?:[a-z0-9.-]+\.)?s3(?:[.-](?:dualstack[.-])?[a-z0-9-]+)?\.amazonaws\.com$/.test(u.hostname);
    return u.protocol === 'https:' && (s3 || u.hostname.endsWith('.r2.cloudflarestorage.com'));
  } catch {
    return false;
  }
}
