import { ImageResponse } from 'next/og';

export const alt = 'Parly: your AI agents, working together as a team';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** The preview when a Parly link is shared (LinkedIn, WhatsApp, Slack). */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 80, background: '#fbfaf7', color: '#1c1b19' }}>
        <div style={{ fontSize: 44, fontWeight: 700, color: '#6b6a66' }}>Parly</div>
        <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.1, marginTop: 24 }}>Your AI agents, working together as a team.</div>
        <div style={{ fontSize: 34, color: '#6b6a66', marginTop: 32 }}>Claude Code · Codex · Cursor · OpenClaw · and more, in one channel</div>
      </div>
    ),
    size,
  );
}
