import nodemailer from 'nodemailer';

interface InviteMail {
  email: string;
  workspaceName: string;
  invitedByName: string;
  /** An invite to the other side of a shared room: what it's for, and the side inviting. */
  room?: { goal: string; workspaceId: string; fromSide?: string };
  /** An invite to join a company's billing (`workspaceName` is the company's name). */
  company?: boolean;
}

export type InviteMailer = (mail: InviteMail) => Promise<void>;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Sends invite emails from a Gmail account via an app password. Unset user, password or `webUrl` disables email (invites still work). */
export function inviteMailer(user: string | undefined, appPassword: string | undefined, webUrl: string | undefined): InviteMailer | undefined {
  if (!user || !appPassword || !webUrl) return undefined;
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass: appPassword } });
  const from = `Parly <${user}>`;
  return async ({ email, workspaceName, invitedByName, room, company }) => {
    const name = esc(workspaceName);
    const by = esc(invitedByName);
    if (company) {
      const link = `${webUrl}/login?next=${encodeURIComponent('/billing')}`;
      await transport.sendMail({
        from,
        to: email,
        subject: `${invitedByName} invited you to ${workspaceName}'s billing on Parly`,
        text: `${invitedByName} invited you to join ${workspaceName}'s billing on Parly: their plan pays for your agents.\n\nSign in with Google as ${email} to accept: ${link}`,
        html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#17161c;text-align:center">
  <h1 style="font-size:22px;margin:0 0 8px">Join ${name} on Parly</h1>
  <p style="font-size:15px;line-height:1.5;margin:0 0 24px"><b>${by}</b> invited you to ${name}'s billing: their plan pays for your agents. Sign in with Google as <b>${esc(email)}</b> to accept.</p>
  <a href="${link}" style="display:inline-block;background:#17161c;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600">Accept</a>
</div>`,
      });
      return;
    }
    if (room) {
      // A room: what they're asked to do, how it works, and what the other side never sees.
      const link = `${webUrl}/login?next=${encodeURIComponent(`/rooms/${room.workspaceId}/side`)}`;
      const who = room.fromSide ? `${invitedByName} (${room.fromSide})` : invitedByName;
      const steps = [
        'Tell your agent what you want, what you won\'t compromise on, and what it may share. Only your side sees this.',
        "Your agent talks with theirs, writes a summary, and asks you when it's your call.",
        'Nothing is final until you approve it for your side.',
      ];
      const privacy = "They never see your instructions, your private chat with your agent, or anything else of yours.";
      await transport.sendMail({
        from,
        to: email,
        subject: `${who} invited you to work this out together: ${room.goal}`,
        text: `${who} invited you to a shared room on Parly, to work this out together:\n\n  ${room.goal}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n${privacy}\n\nSign in with Google as ${email} to set up your side: ${link}\n\nThe invite lasts 30 days.`,
        html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#17161c">
  <p style="font-size:14px;color:#77757f;margin:0 0 6px">${esc(who)} invited you to work this out together</p>
  <h1 style="font-size:22px;margin:0 0 20px">${esc(room.goal)}</h1>
  <ol style="font-size:15px;line-height:1.5;margin:0 0 16px;padding-left:20px">${steps.map((s) => `<li style="margin-bottom:6px">${esc(s)}</li>`).join('')}</ol>
  <p style="font-size:14px;line-height:1.5;margin:0 0 24px;color:#3d3b45">${esc(privacy)}</p>
  <a href="${link}" style="display:inline-block;background:#17161c;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600">Set up your side</a>
  <p style="font-size:12px;color:#77757f;margin-top:24px">Sign in with Google as <b>${esc(email)}</b>. The invite lasts 30 days.</p>
</div>`,
      });
      return;
    }
    await transport.sendMail({
      from,
      to: email,
      subject: `${invitedByName} invited you to ${workspaceName} on Parly`,
      text: `${invitedByName} invited you to the workspace "${workspaceName}" on Parly.\n\nSign in with Google as ${email} to join: ${webUrl}/login\n\nThe invite lasts 30 days.`,
      html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:32px 16px;color:#17161c;text-align:center">
  <img src="${webUrl}/invite-crew.png" width="514" alt="The Parly crew" style="max-width:100%;height:auto">
  <h1 style="font-size:22px;margin:24px 0 8px">You're invited to ${name}</h1>
  <p style="font-size:15px;line-height:1.5;margin:0 0 24px"><b>${by}</b> wants you in the workspace. Sign in with Google as <b>${esc(email)}</b> and you're in.</p>
  <a href="${webUrl}/login" style="display:inline-block;background:#17161c;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:600">Join ${name}</a>
  <p style="font-size:12px;color:#77757f;margin-top:24px">The invite lasts 30 days.</p>
</div>`,
    });
  };
}

/** A plain notice to the hub's own people (e.g. an Enterprise lead to the super admins). */
export type NoticeMailer = (to: string[], subject: string, text: string) => Promise<void>;

export function noticeMailer(user: string | undefined, appPassword: string | undefined): NoticeMailer | undefined {
  if (!user || !appPassword) return undefined;
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass: appPassword } });
  return async (to, subject, text) => {
    if (to.length) await transport.sendMail({ from: `Parly <${user}>`, to, subject, text });
  };
}
