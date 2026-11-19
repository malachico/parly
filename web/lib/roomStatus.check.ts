// ponytail: one runnable check for the readyToApprove gate (seq-1768 bug). Run: node --import tsx lib/roomStatus.check.ts
import assert from 'node:assert';
import { roomStatus } from './roomStatus';

const base = {
  room: { sides: [{ id: 'me', name: 'Me' }, { id: 'you', name: 'You' }], mySide: { id: 'me' } },
  doc: { version: 3, approvals: {} as Record<string, { version: number }> },
  agreed: false,
};

// Agents still writing the draft: approve is reachable but NOT the loud primary move.
assert.equal(roomStatus({ ...base }).readyToApprove, false, 'plain draft must not be ready');

// Other side approved this version → my move.
assert.equal(roomStatus({ ...base, doc: { version: 3, approvals: { you: { version: 3 } } } }).readyToApprove, true, 'other-approved is ready');

// Agents stopped without agreeing → the draft isn't agreed; unstick it, don't loudly approve.
assert.equal(roomStatus({ ...base, stuck: true }).readyToApprove, false, 'stuck is not ready');

// Stuck even though the other side approved an earlier version: stuck wins, still not a loud approve.
assert.equal(roomStatus({ ...base, stuck: true, doc: { version: 3, approvals: { you: { version: 3 } } } }).readyToApprove, false, 'stuck beats other-approved');

// No agents in the room → people approve it themselves.
assert.equal(roomStatus({ ...base, noAgents: true }).readyToApprove, true, 'noAgents is ready');

// Already agreed by both → nothing to approve.
assert.equal(roomStatus({ ...base, agreed: true, doc: { version: 3, approvals: { me: { version: 3 }, you: { version: 3 } } } }).readyToApprove, false, 'agreed is not ready');

// Room closed (a side passed) → no approve, loud or otherwise, even if the other side had approved (seq-1781).
const closed = roomStatus({ ...base, closed: true, doc: { version: 3, approvals: { you: { version: 3 } } } });
assert.equal(closed.canApprove, false, 'closed cannot approve');
assert.equal(closed.readyToApprove, false, 'closed is not ready');

console.log('roomStatus readyToApprove: ok');
