/** Memoizes an async loader, but never caches a rejection: after a failed load the next call retries. */
export function retryingMemo<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () =>
    (cached ??= load().catch((err) => {
      cached = undefined;
      throw err;
    }));
}
