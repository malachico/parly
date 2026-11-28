import { createElement, memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '@/components/CopyButton';

export type Mentioned = { label: string; me: boolean };

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: { hName?: string; hProperties?: Record<string, string> } };

/**
 * A remark plugin that turns each "@Name" of a mentioned person into a chip, with the hub's boundaries
 * (src/hub/mentions.ts) so an email address stays text. Code and links are left as written.
 */
function remarkMentions(mentioned: Mentioned[]) {
  const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = mentioned.length ? new RegExp(`(?<![\\p{L}\\p{N}_.])@(?:${mentioned.map((x) => escape(x.label)).join('|')})(?![\\p{L}\\p{N}_-])`, 'giu') : null;
  const chip = (text: string): MdNode => {
    const me = mentioned.some((x) => x.me && x.label.toLowerCase() === text.slice(1).toLowerCase());
    return { type: 'mention', data: { hName: 'span', hProperties: { className: me ? 'mention mention-me' : 'mention' } }, children: [{ type: 'text', value: text }] };
  };
  const split = (value: string): MdNode[] => {
    const out: MdNode[] = [];
    let last = 0;
    for (const hit of value.matchAll(re!)) {
      const at = hit.index ?? 0;
      if (at > last) out.push({ type: 'text', value: value.slice(last, at) });
      out.push(chip(hit[0]));
      last = at + hit[0].length;
    }
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
    return out;
  };
  const walk = (node: MdNode) => {
    if (!re || !node.children || node.type === 'link') return;
    node.children = node.children.flatMap((c) => {
      if (c.type === 'text' && c.value) return split(c.value);
      walk(c);
      return [c];
    });
  };
  return () => (tree: unknown) => walk(tree as MdNode);
}

/** No raw HTML: react-markdown escapes it, so agent text can't inject markup. */
/** The words of a markdown node (its hast tree), for working out its direction: inline code (a path, a URL) isn't language. */
type HastNode = { type?: string; tagName?: string; value?: string; children?: HastNode[] };
const nodeText = (n?: HastNode): string => (n?.type === 'text' ? (n.value ?? '') : n?.tagName === 'code' ? '' : (n?.children ?? []).map(nodeText).join(''));

/**
 * Hebrew and English mix in one chat: every block takes its direction from its own letters, so a Hebrew line that
 * opens with "Parly" or "@name" stays right-to-left and an English one in a Hebrew message left-to-right. A block with
 * no letters (a hash, code) follows the message (`inRtl`), or else its first letter.
 */
const autoDir = (tag: string, inRtl: boolean) =>
  function AutoDir({ node, ...props }: { node?: unknown }) {
    const text = nodeText(node as HastNode);
    const dir = messageDir(text) ?? (/[A-Za-z]/.test(text) ? 'ltr' : inRtl ? undefined : 'auto');
    return createElement(tag, { ...(dir ? { dir } : {}), ...props });
  };
const BLOCKS = ['p', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'td', 'th'];
const LINK: Components['a'] = ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noopener noreferrer" />;
// Reserve media space even when an agent embeds an external image in Markdown.
const MARKDOWN_IMAGE: Components['img'] = ({ node: _n, ...props }) => (
  // External chat images aren't optimized by next/image; no-referrer so the hub URL isn't sent to third parties (#17).
  <img {...props} loading="lazy" referrerPolicy="no-referrer" className="h-64 w-72 max-w-full rounded-lg object-contain" />
);
/** All of a node's text, code included (nodeText skips code on purpose, for direction). */
const allText = (n?: HastNode): string => (n?.type === 'text' ? (n.value ?? '') : (n?.children ?? []).map(allText).join(''));
/** A code block with a copy button that stays put while the code scrolls sideways. */
const PRE: Components['pre'] = ({ node, ...props }) => (
  <div className="relative">
    <pre {...props} />
    <span className="absolute top-1.5 right-1.5">
      <CopyButton value={allText(node as HastNode).replace(/\n$/, '')} label="Copy code" />
    </span>
  </div>
);
const MD_COMPONENTS: Components = { a: LINK, img: MARKDOWN_IMAGE, pre: PRE, ...Object.fromEntries(BLOCKS.map((t) => [t, autoDir(t, false)])) };
const MD_COMPONENTS_RTL: Components = { a: LINK, img: MARKDOWN_IMAGE, pre: PRE, ...Object.fromEntries(BLOCKS.map((t) => [t, autoDir(t, true)])) };

/**
 * A message's direction, from its letters: right-to-left when a fair share are Hebrew or Arabic.
 * Agents' Hebrew is full of English terms, so a third is enough.
 */
// ponytail: letter count, not a bidi algorithm; per-block auto still handles English messages
function messageDir(text: string): 'rtl' | undefined {
  const rtl = text.match(/[\u0590-\u05FF\u0600-\u06FF]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return rtl > 0 && rtl / (rtl + latin) >= 0.3 ? 'rtl' : undefined;
}

/**
 * Text with nothing markdown or remark-gfm would turn into markup: no inline syntax, no block starts, no indented
 * code, no URL autolinks, no @mentions or emails. Such text renders as plain paragraphs, skipping the parser.
 */
const INLINE_SYNTAX = /[*_`~[\]!<>&\\|@]|:\/\/|www\./i;
const BLOCK_START = /^(?: {4}|\t| {0,3}(?:[#>+=*-]|\d+[.)]))/m;
const isPlain = (text: string) => !INLINE_SYNTAX.test(text) && !BLOCK_START.test(text);

function MarkdownImpl({ text, className = '', mentioned = [] }: { text: string; className?: string; mentioned?: Mentioned[] }) {
  const dir = messageDir(text);
  // Built once per set of mentions, not every render: `mentioned` is a fresh array each time, so key on its content.
  // (useMemo, not a ref: server pages render Markdown too.)
  const key = JSON.stringify(mentioned);
  const plugins = useMemo(() => [remarkGfm, remarkMentions(JSON.parse(key) as Mentioned[])], [key]);
  if (isPlain(text)) {
    // The same paragraphs react-markdown would make (blank lines split them; .md p keeps single newlines), with each one's direction as autoDir gives it.
    const paragraphs = text.trim() ? text.trim().split(/\n[ \t]*\n\s*/) : [];
    return (
      <div dir={dir} className={`md break-words ${className}`}>
        {paragraphs.map((p, i) => {
          const pDir = messageDir(p) ?? (/[A-Za-z]/.test(p) ? 'ltr' : dir ? undefined : 'auto');
          return (
            <p key={i} {...(pDir ? { dir: pDir } : {})}>
              {p}
            </p>
          );
        })}
      </div>
    );
  }
  return (
    <div dir={dir} className={`md break-words ${className}`}>
      <ReactMarkdown remarkPlugins={plugins} components={dir ? MD_COMPONENTS_RTL : MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Re-renders only when the text, class or the mentions' content change (`mentioned` is a fresh array each time). */
export const Markdown = memo(
  MarkdownImpl,
  (a, b) => a.text === b.text && a.className === b.className && JSON.stringify(a.mentioned ?? []) === JSON.stringify(b.mentioned ?? []),
);
