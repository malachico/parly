'use client';

import { useState } from 'react';
import type { ProcessStepView } from '@/lib/hub';

type EditableProcessStep = {
  key: string;
  role: string;
  action: string;
  output: string;
  transition: string;
  skillId: string;
};

const STARTER_STEPS: Omit<EditableProcessStep, 'key'>[] = [
  {
    role: 'implementer',
    action: 'Build the smallest change that works and add a test that fails before / passes after.',
    output: 'PR link + green tests',
    transition: 'PR open and CI green',
    skillId: '',
  },
  {
    role: 'reviewer',
    action: 'Review against the real PR diff and verify edge cases and permissions.',
    output: 'Approve or changes-requested',
    transition: 'Reviewer approves',
    skillId: '',
  },
];

/**
 * Interactive ordered step builder for a team Process:
 * each row defines `role · action / output / transition` + an optional "Link a skill" dropdown by name.
 */
export function ProcessStepsEditor({
  initialSteps,
  availableSkills,
}: {
  initialSteps?: ProcessStepView[];
  availableSkills: { id: string; name: string }[];
}) {
  const [steps, setSteps] = useState<EditableProcessStep[]>(() => {
    const src =
      initialSteps && initialSteps.length > 0
        ? initialSteps.map((s) => ({
            role: s.role,
            action: s.action,
            output: s.output,
            transition: s.transition,
            skillId: s.skillId ?? '',
          }))
        : STARTER_STEPS;
    return src.map((s, idx) => ({ ...s, key: `step-${idx}` }));
  });

  const updateStep = (index: number, patch: Partial<EditableProcessStep>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const addStep = () => {
    setSteps((prev) => [
      ...prev,
      { key: `step-${Date.now()}-${prev.length}`, role: '', action: '', output: '', transition: '', skillId: '' },
    ]);
  };

  const removeStep = (index: number) => {
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  const moveStep = (index: number, dir: -1 | 1) => {
    setSteps((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item!);
      return copy;
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-sm font-medium">Process steps</span>
          <p className="text-xs text-[var(--muted)]">
            Each row sets the role, what they do, the expected output, the transition gate, and an optional linked skill.
          </p>
        </div>
        <button type="button" onClick={addStep} className="btn min-h-8 px-2.5 text-xs">
          ＋ Add step
        </button>
      </div>

      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={step.key} className="space-y-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg)] p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300">
                <span className="inline-flex size-5 items-center justify-center rounded-full bg-amber-500/15 text-[11px] font-bold">
                  {i + 1}
                </span>
                Step {i + 1}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => moveStep(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move step ${i + 1} up`}
                  className="rounded px-1.5 py-0.5 text-xs text-[var(--muted)] hover:bg-[var(--subtle)] disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveStep(i, 1)}
                  disabled={i === steps.length - 1}
                  aria-label={`Move step ${i + 1} down`}
                  className="rounded px-1.5 py-0.5 text-xs text-[var(--muted)] hover:bg-[var(--subtle)] disabled:opacity-30"
                >
                  ↓
                </button>
                {steps.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeStep(i)}
                    aria-label={`Remove step ${i + 1}`}
                    className="rounded px-1.5 py-0.5 text-xs text-[var(--bad-fg)] hover:bg-[var(--subtle)]"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-[var(--muted)]">Role</span>
                <input
                  name="step_role"
                  value={step.role}
                  onChange={(e) => updateStep(i, { role: e.target.value })}
                  required
                  placeholder="e.g. implementer, reviewer, lead"
                  className="input py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-[var(--muted)]">Link a skill (optional)</span>
                <select
                  name="step_skillId"
                  value={step.skillId}
                  onChange={(e) => updateStep(i, { skillId: e.target.value })}
                  className="input py-1.5 text-sm"
                >
                  <option value="">None</option>
                  {availableSkills.map((sk) => (
                    <option key={sk.id} value={sk.id}>
                      📘 {sk.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-[var(--muted)]">Action</span>
              <input
                name="step_action"
                value={step.action}
                onChange={(e) => updateStep(i, { action: e.target.value })}
                required
                placeholder="What this role does in this step"
                className="input py-1.5 text-sm"
              />
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-[var(--muted)]">Output</span>
                <input
                  name="step_output"
                  value={step.output}
                  onChange={(e) => updateStep(i, { output: e.target.value })}
                  required
                  placeholder="e.g. PR link posted, tests green"
                  className="input py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium text-[var(--muted)]">Transition gate</span>
                <input
                  name="step_transition"
                  value={step.transition}
                  onChange={(e) => updateStep(i, { transition: e.target.value })}
                  required
                  placeholder="e.g. PR open + CI green"
                  className="input py-1.5 text-sm"
                />
              </label>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
