/** The agent choice that asks Parly to make a side an agent of its own. */
export const OWN_AGENT = 'own-agent';

type Facts = {
  room: { sides: { id: string; name: string }[]; mySide?: { id: string } };
  doc?: { version: number; approvals: Record<string, { version: number }> };
  agreed: boolean;
  stuck?: boolean;
  /** The room was closed (e.g. a side passed): it's over, nothing left to approve. */
  closed?: boolean;
  progress?: { lastSide?: string; waiting?: { side: string } };
  /** Neither side has an agent in the room: the people work it out themselves. */
  noAgents?: boolean;
};

/** Where a shared room stands, in one sentence, and what it asks of the person reading it. */
export function roomStatus({ room, doc, agreed, stuck, closed, progress, noAgents }: Facts) {
  const me = room.mySide?.id;
  const others = room.sides.filter((s) => s.id !== me);
  const approved = (id: string) => doc?.approvals[id]?.version === doc?.version && !!doc;
  const iApproved = !!me && approved(me);
  const othersApproved = others.filter((s) => approved(s.id));
  const waiting = progress?.waiting;
  const myDecision = !!waiting && waiting.side === me;
  const canApprove = !!doc && !!me && !iApproved && !agreed && !closed;
  const nameOf = (id: string) => room.sides.find((s) => s.id === id)?.name ?? 'the other side';
  const next = progress?.lastSide ? others.concat(room.sides.filter((s) => s.id === me)).filter((s) => s.id !== progress.lastSide) : [];

  let tone: 'ok' | 'warn' | 'muted' = 'muted';
  let text: string;
  if (agreed) [tone, text] = ['ok', `Agreed by both sides (version ${doc?.version})`];
  else if (closed) [tone, text] = ['muted', 'This room is closed. Nothing left to do here.'];
  else if (waiting) [tone, text] = myDecision ? ['warn', 'Your agent needs your decision to go on'] : ['muted', `Waiting for ${nameOf(waiting.side)} to decide`];
  else if (stuck) [tone, text] = ['warn', "The agents stopped without agreeing. It's up to you: tell your agent what to do, or write to the other side."];
  else if (room.sides.length < 2) text = 'Waiting for the other side to join';
  else if (iApproved) text = `You approved version ${doc!.version}. Waiting for ${others.map((s) => s.name).join(', ')}.`;
  else if (othersApproved.length && canApprove) [tone, text] = ['warn', `${othersApproved.map((s) => s.name).join(', ')} approved version ${doc!.version}. Your turn to review it.`];
  else if (noAgents) text = 'No agents in this room. You and the other side work it out here, then approve the summary.';
  else if (next.length) text = `The agents are talking: ${next.some((s) => s.id === me) ? 'your agent' : `${next.map((s) => s.name).join(', ')}'s agent`} is next. Nothing needed from you right now.`;
  else text = 'The agents are starting. Nothing needed from you right now.';

  // readyToApprove: approving is actually the person's move now — the other side already approved this
  // version, or there are no agents and the people write the summary themselves. Not while the agents are
  // still talking, and not when they stopped without agreeing (stuck): that draft isn't agreed, so the
  // card offers "tell your agent"/"write to the other side", not a loud approve.
  const readyToApprove = canApprove && !stuck && (othersApproved.length > 0 || !!noAgents);
  return { tone, text, myDecision, canApprove, readyToApprove, isDraft: !!doc && !agreed };
}

/** What a room's composer says, so nobody has to guess who reads it. Undefined outside a room's two conversations. */
export function roomPlaceholder(room: { shared: string; mySide?: { corner: string } } | undefined, channelId: string): string | undefined {
  if (room?.shared === channelId) return 'Both sides read this';
  if (room?.mySide?.corner === channelId) return 'Only your side sees this';
  return undefined;
}
