'use client';

import { useEffect } from 'react';
import { warmHostedAgent } from '@/lib/actions';

/** Opening the chat with your hosted agent starts its computer, so the first answer doesn't wait on a cold boot. */
export function WarmComputer({ agentId }: { agentId: string }) {
  useEffect(() => void warmHostedAgent(agentId).catch(() => {}), [agentId]);
  return null;
}
