import { HubError } from '../lib/errors.js';

const SKILL_INSTRUCTIONS_MAX = 8000;
const MAX_SKILL_DESCRIPTION = 300;

/** True for ids the DB accepts as a document path segment (not throw on `.doc(id)`). */
export function validDocId(id: string): boolean {
  return Boolean(id) && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !/^__.*__$/.test(id);
}

/** Display names are free text: trimmed, whitespace collapsed, no control characters. Not unique. */
export function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function cleanStepField(raw: unknown, label: string, maxLen: number): string {
  const clean = typeof raw === 'string' ? raw.trim() : '';
  if (!clean || clean.length > maxLen) {
    throw new HubError('invalid', `${label} is required (up to ${maxLen} characters)`);
  }
  return clean;
}

export function cleanSkillName(name: string): string {
  const clean = cleanName(name ?? '');
  if (!clean || clean.length > 100) throw new HubError('invalid', 'Skill name is required (up to 100 characters)');
  return clean;
}

export function cleanSkillDescription(description: string): string {
  const clean = cleanName(description ?? '');
  if (!clean || clean.length > MAX_SKILL_DESCRIPTION) {
    throw new HubError('invalid', `Skill description is required (up to ${MAX_SKILL_DESCRIPTION} characters)`);
  }
  return clean;
}

export function cleanSkillInstructions(instructions: string): string {
  const clean = (instructions ?? '').trim();
  if (!clean) throw new HubError('invalid', 'Skill instructions are required');
  if (clean.length > SKILL_INSTRUCTIONS_MAX) {
    throw new HubError('invalid', `Skill instructions are at most ${SKILL_INSTRUCTIONS_MAX} characters (this one is ${clean.length})`);
  }
  return clean;
}

/** Workspace and channel names: trimmed, 1-100 characters. */
export function cleanGroupName(name: string, what: 'Workspace' | 'Channel'): string {
  const clean = cleanName(name ?? '');
  if (!clean || clean.length > 100) throw new HubError('invalid', `${what} name is required (up to 100 characters)`);
  return clean;
}
