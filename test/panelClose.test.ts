import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { panelClosing, panelCoversCanvas, publishPanelClosing, subscribePanelClosing } from '../web/lib/panelClosing.js';

/** On a phone the canvas is hidden behind a panel. Closing hides the panel at once, so the canvas must come back then, not when the route commits. */
it('reveals the canvas when the panel closes, before the route commits', () => {
  const covered = (path: string) => panelCoversCanvas('ws1', path, null, panelClosing());
  let notified = 0;
  const off = subscribePanelClosing(() => notified++);
  expect(covered('/w/ws1/c/channel%3Ach1')).toBe(true);
  publishPanelClosing(true); // the close click; the route has not changed yet
  expect(notified).toBe(1);
  expect(covered('/w/ws1/c/channel%3Ach1')).toBe(false);
  publishPanelClosing(false); // the route commits, PanelSlot's `closing` resets
  expect(covered('/w/ws1')).toBe(false);
  expect(panelCoversCanvas('ws1', '/w/ws1', 'apps', false)).toBe(true);
  off();
});

it('PanelSlot publishes its closing state and the canvas reads it', () => {
  expect(readFileSync('web/components/PanelSlot.tsx', 'utf8')).toMatch(/publishPanelClosing\(closing\)/);
  expect(readFileSync('web/components/CrewCanvas.tsx', 'utf8')).toMatch(/useSyncExternalStore\(subscribePanelClosing, panelClosing/);
});
