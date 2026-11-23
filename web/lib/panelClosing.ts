import { wsHref } from './routes';

// PanelSlot hides a closing panel before the route commits; it publishes that here so the canvas un-hides in the same frame.
let closing = false;
const subs = new Set<() => void>();
export const subscribePanelClosing = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};
export const panelClosing = () => closing;
export function publishPanelClosing(next: boolean) {
  if (closing === next) return;
  closing = next;
  for (const fn of subs) fn();
}

/** Whether a panel is showing over the canvas: a panel route that PanelSlot has not already hidden. */
export const panelCoversCanvas = (ws: string, path: string, panel: string | null, isClosing: boolean) =>
  !isClosing && (path !== wsHref(ws) || !!panel);
