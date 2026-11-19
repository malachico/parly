/** Graceful shutdown shared by SIGTERM and the uncaught-exception safety net in index.ts. */

interface ClosableServer {
  close(cb: () => void): void;
}

interface Drainable {
  push: { shutdown(): Promise<void> };
  wakeService: { idle(): Promise<void> };
}

/**
 * Returns a `shutdown(code)` that frees this instance's push leases, drains in-flight turns, then exits.
 *
 * Reused by the crash path: an uncaught exception leaves us in an undefined state, where `server.close`/`idle`
 * can hang on a stuck connection. On SIGTERM Cloud Run's SIGKILL bounds that; on a crash nothing does, so a
 * non-zero `code` arms a hard deadline that exits anyway (kept under the ~10s grace). A second trigger is a no-op.
 */
export function makeShutdown(
  server: ClosableServer,
  hub: Drainable,
  exit: (code: number) => void,
  crashDeadlineMs = 8000,
): (code: number) => void {
  let shuttingDown = false;
  return (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void hub.push.shutdown();
    if (code !== 0) setTimeout(() => exit(code), crashDeadlineMs);
    server.close(() => void hub.wakeService.idle().finally(() => exit(code)));
  };
}
