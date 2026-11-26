import { describe, expect, it } from 'vitest';
import { newSkillScope } from '../web/lib/skillScope.js';

describe('newSkillScope', () => {
  it('workspace skills page creates a workspace skill', () => {
    expect(newSkillScope('ws1', '', '', false)).toEqual({ scope: 'workspace', id: 'ws1' });
  });
  it('agent page with attach checked targets the agent', () => {
    expect(newSkillScope('ws1', 'agent', 'a1', false)).toEqual({ scope: 'agent', id: 'a1' });
  });
  it('agent page with both boxes unchecked stays personal', () => {
    expect(newSkillScope('ws1', '', 'a1', false)).toBeUndefined();
  });
  it('agent page with only "entire workspace" checked creates a workspace skill', () => {
    expect(newSkillScope('ws1', '', 'a1', true)).toEqual({ scope: 'workspace', id: 'ws1' });
  });
});
