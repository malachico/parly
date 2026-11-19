import { expect, it } from 'vitest';
import { agentRunMax, agentRunMaxMentioned } from '../src/chat/chat.js';

it('vitest.config.ts does not set global AGENT_RUN_MAX overrides, and examples are exercised', async () => {
  expect(process.env.AGENT_RUN_MAX).toBeUndefined();
  expect(process.env.AGENT_RUN_MAX_MENTIONED).toBeUndefined();
  expect(agentRunMax()).toBe(1000);
  expect(agentRunMaxMentioned()).toBe(4000);
});
