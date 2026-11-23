'use client';

import { catchError } from 'next/error';
import PanelError from '@/app/(window)/w/[ws]/error';

/** The canvas's own error boundary: it lives in the workspace layout, which that segment's `error.tsx` can't cover. */
export const CanvasBoundary = catchError((_props: object, info) => (
  <PanelError error={info.error as Error & { digest?: string }} retry={info.retry} reset={info.reset} scope="canvas" />
));
