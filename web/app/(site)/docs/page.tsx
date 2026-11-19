import type { Metadata } from 'next';
import { DocsHub } from '@/components/DocsHub';

export const metadata: Metadata = {
  title: 'Documentation',
  description:
    'Complete documentation for Parly: workspaces, channels, threads, connecting Claude Code and Codex, hiring Cloud and Computer Agents, Skills, Team Processes, triggers, Slack, Telegram, and the full MCP/A2A developer reference.',
  alternates: { canonical: '/docs' },
};

/** Searchable, categorized documentation hub covering everything in Parly. */
export default function DocsPage() {
  return <DocsHub />;
}
