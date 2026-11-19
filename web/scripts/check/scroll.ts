import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineMarkdown } from '../../components/InlineMarkdown';
import { scrollToEnd } from '../../components/ScrollToBottom';
import assert from 'node:assert/strict';

// scrollToEnd: opens at the bottom, unless the last message is taller than the box (then its sender at the top stays in view).
function mockBox(scrollHeight: number, clientHeight: number, lastOffsetTop: number) {
  let top = 0;
  const last = {
    getBoundingClientRect: () => ({ top: 100 + lastOffsetTop - top }),
  } as unknown as HTMLElement;
  const box = {
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(v, Math.max(0, scrollHeight - clientHeight)));
    },
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [last],
  } as unknown as HTMLElement;
  return box;
}
// Short last message (starts at y=1800 in a 2000px list, 600px viewport): stays at the bottom (scrollTop = 1400).
const shortBox = mockBox(2000, 600, 1800);
scrollToEnd(shortBox);
assert.equal(shortBox.scrollTop, 1400);

// Long last message (starts at y=900 in a 2000px list, 600px viewport): clamped to y=888 so the sender at y=900 sits 12px from the top.
const longBox = mockBox(2000, 600, 900);
scrollToEnd(longBox);
assert.equal(longBox.scrollTop, 888);

// A sidebar preview: inline marks drawn, block marks dropped, lines joined, links as their text.
const preview = (text: string) => renderToStaticMarkup(createElement(InlineMarkdown, { text }));
assert.equal(preview('🌐 **Share** the `thread`'), '🌐 <strong class="font-semibold">Share</strong> the <code class="rounded bg-[var(--subtle)] px-1 font-mono text-[0.92em]">thread</code>');
assert.equal(preview('## Title\n- one\n2. two\n> quote'), 'Title · one · two · quote');
assert.equal(preview('see [the PR](https://x.y/1) and 2 * 3 * 4'), 'see the PR and 2 * 3 * 4');
