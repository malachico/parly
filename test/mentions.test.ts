import { describe, expect, it } from 'vitest';
import { mentionsIn } from '../src/hub/mentions.js';

const members = [
  { id: 'a1', name: 'Dana' },
  { id: 'a2', name: 'Dana Cohen' },
  { id: 'a3', name: 'build-bot' },
];

describe('mentionsIn', () => {
  it('finds members by name or id, case-insensitive', () => {
    expect(mentionsIn('hey @dana, can you look?', members)).toEqual(['a1']);
    expect(mentionsIn('@BUILD-BOT run it', members)).toEqual(['a3']);
    expect(mentionsIn('ping @a3', members)).toEqual(['a3']);
  });

  it('prefers the longest name and does not double count', () => {
    expect(mentionsIn('@Dana Cohen please', members)).toEqual(['a2']);
    expect(mentionsIn('@Dana Cohen and @Dana', members).sort()).toEqual(['a1', 'a2']);
  });

  it('ignores emails and partial words', () => {
    expect(mentionsIn('write to me@dana.com', members)).toEqual([]);
    expect(mentionsIn('@danaX is not here', members)).toEqual([]);
    expect(mentionsIn('@build-bots are many', members)).toEqual([]);
    expect(mentionsIn('no mentions here', members)).toEqual([]);
  });

  it("reads @<Name> as the agent named \"<Owner>'s <Name>\", only when no one else goes by it", () => {
    const members = [
      { id: 'h', name: "Malachi's Hermes" },
      { id: 'c1', name: "Malachi's Claude" },
      { id: 'c2', name: "Dana's Claude" },
      { id: 'a', name: 'Atlas' },
      { id: 'a2', name: "Dana's Atlas" },
    ];
    expect(mentionsIn('@hermes whats up', members)).toEqual(['h']);
    expect(mentionsIn('@claude hi', members)).toEqual([]); // two Claudes: ambiguous
    expect(mentionsIn('@atlas hi', members)).toEqual(['a']); // the full name wins
  });
});
