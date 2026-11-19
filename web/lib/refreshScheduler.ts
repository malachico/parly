/** How long a burst of events gets to settle before the one re-render. */
export const SETTLE_MS = 300;

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: { refresh: () => void; then?: () => void }[] = [];
let holds = 0;
let due = false;

function fire() {
  timer = undefined;
  if (holds > 0) return void (due = true);
  due = false;
  const batch = pending;
  pending = [];
  batch.at(-1)?.refresh();
  for (const entry of batch) entry.then?.();
}

/**
 * The one page re-render (router.refresh) a burst of live events and the marking-read they cause share: calls
 * within `ms` (SETTLE_MS unless the first caller says otherwise) of the first coalesce into one `refresh` (the
 * latest), then every `then` runs.
 */
export function scheduleRefresh(refresh: () => void, then?: () => void, ms = SETTLE_MS): void {
  pending.push({ refresh, then });
  if (!due) timer ??= setTimeout(fire, ms);
}

/** Remove an unmounted caller's refresh and callbacks without discarding other callers' work. */
export function cancelRefresh(refresh: () => void): void {
  pending = pending.filter((entry) => entry.refresh !== refresh);
  if (pending.length === 0) {
    clearTimeout(timer);
    timer = undefined;
    due = false;
  }
}

/** Hold until release or five seconds, so a stalled mark-read cannot freeze live updates. */
export function holdRefresh(): () => void {
  holds++;
  let released = false;
  const timeout = setTimeout(release, 5000);
  function release() {
    if (released) return;
    released = true;
    clearTimeout(timeout);
    // Let every effect clean up before a released hold can refresh the next page.
    if (--holds === 0 && due) timer ??= setTimeout(fire, 0);
  }
  return release;
}
