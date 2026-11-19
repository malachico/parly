import { describe, expect, it } from 'vitest';
import { roomPlaceholder, roomStatus } from '../web/lib/roomStatus.js';

const room = { sides: [{ id: 'a', name: 'Acme' }, { id: 'b', name: 'Beta' }], mySide: { id: 'a' } };
const doc = (approvals: Record<string, { version: number }> = {}) => ({ version: 2, approvals });

describe('roomStatus', () => {
  it('waits for the other side before anything else', () => {
    expect(roomStatus({ room: { sides: [room.sides[0]!], mySide: { id: 'a' } }, agreed: false }).text).toBe('Waiting for the other side to join');
  });

  it('says whose agent is next, and that nothing is needed, in talks', () => {
    expect(roomStatus({ room, agreed: false, progress: { lastSide: 'b' } }).text).toMatch(/your agent is next. Nothing needed/);
    expect(roomStatus({ room, agreed: false, progress: { lastSide: 'a' } }).text).toMatch(/Beta's agent is next/);
  });

  it('a draft is a draft: it can be reviewed, and is not agreed', () => {
    const s = roomStatus({ room, doc: doc(), agreed: false });
    expect(s).toMatchObject({ canApprove: true, isDraft: true });
  });

  it('an approval of an older version does not count', () => {
    const s = roomStatus({ room, doc: doc({ a: { version: 1 }, b: { version: 1 } }), agreed: false });
    expect(s.canApprove).toBe(true);
    expect(s.text).not.toMatch(/approved/);
  });

  it('asks me to review once the other side approved this version', () => {
    const s = roomStatus({ room, doc: doc({ b: { version: 2 } }), agreed: false });
    expect(s.tone).toBe('warn');
    expect(s.text).toBe('Beta approved version 2. Your turn to review it.');
  });

  it('after I approve, it waits for them and asks nothing of me', () => {
    const s = roomStatus({ room, doc: doc({ a: { version: 2 } }), agreed: false });
    expect(s.canApprove).toBe(false);
    expect(s.text).toBe('You approved version 2. Waiting for Beta.');
  });

  it('a decision outranks being stuck, and is only mine when it is my side', () => {
    expect(roomStatus({ room, agreed: false, stuck: true, progress: { waiting: { side: 'a' } } })).toMatchObject({ myDecision: true, tone: 'warn' });
    expect(roomStatus({ room, agreed: false, progress: { waiting: { side: 'b' } } })).toMatchObject({ myDecision: false, text: 'Waiting for Beta to decide' });
  });

  it('explains being stuck', () => {
    expect(roomStatus({ room, agreed: false, stuck: true }).text).toMatch(/stopped without agreeing/);
  });

  it('agreed is final', () => {
    const s = roomStatus({ room, doc: doc({ a: { version: 2 }, b: { version: 2 } }), agreed: true });
    expect(s).toMatchObject({ tone: 'ok', canApprove: false, isDraft: false });
  });

  it('does not promise agents that are not there', () => {
    expect(roomStatus({ room, agreed: false, noAgents: true }).text).toMatch(/No agents in this room/);
    expect(roomStatus({ room, agreed: false, noAgents: true, progress: { lastSide: 'a' } }).text).not.toMatch(/agents are talking/);
    expect(roomStatus({ room: { sides: [room.sides[0]!], mySide: { id: 'a' } }, agreed: false, noAgents: true }).text).toBe('Waiting for the other side to join');
  });

  it('someone with no side yet cannot approve', () => {
    expect(roomStatus({ room: { sides: room.sides }, doc: doc(), agreed: false }).canApprove).toBe(false);
  });
});

describe('roomPlaceholder', () => {
  const room = { shared: 's', mySide: { corner: 'c' } };
  it('says who reads what is written in each of the room\'s conversations', () => {
    expect(roomPlaceholder(room, 's')).toBe('Both sides read this');
    expect(roomPlaceholder(room, 'c')).toBe('Only your side sees this');
  });
  it('stays out of everything else', () => {
    expect(roomPlaceholder(room, 'another')).toBeUndefined();
    expect(roomPlaceholder(undefined, 's')).toBeUndefined();
  });
});
