import { describe, expect, it } from 'vitest';
import { mrkdwn } from '../src/slack/bridge.js';

describe("Markdown in Slack's mrkdwn", () => {
  it('converts bold, italics, strike, links, headings and lists, and leaves code alone', () => {
    expect(mrkdwn('**ship** it, *now*, ~~later~~')).toBe('*ship* it, _now_, ~later~');
    expect(mrkdwn('see [the PR](https://github.com/x/y/pull/1)')).toBe('see <https://github.com/x/y/pull/1|the PR>');
    expect(mrkdwn('## Status\n- one\n* two')).toBe('*Status*\n• one\n• two');
    expect(mrkdwn('run `a **b**` and\n```\n**raw**\n```')).toBe('run `a **b**` and\n```\n**raw**\n```');
    expect(mrkdwn('2 * 3 * 4')).toBe('2 * 3 * 4');
  });
});
