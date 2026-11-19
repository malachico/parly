/** Entering or switching a workspace: the canvas background while its layout loads the signed-in user. */
export default function Loading() {
  return <div aria-busy="true" aria-label="Loading" className="h-full flex-1 bg-[var(--bg)]" />;
}
