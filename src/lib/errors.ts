type HubErrorCode = 'invalid' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'unsupported' | 'unavailable' | 'rate_limited' | 'plan_limit';

/** Transport-neutral error; the A2A, MCP and REST layers each map it to their own error shape. */
export class HubError extends Error {
  constructor(
    readonly code: HubErrorCode,
    message: string,
    // Internal-only upstream detail for catch-site decisions; never mapped to agent-facing responses (only `message`/`code` are).
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'HubError';
  }
}

export const HTTP_STATUS_FOR: Record<HubErrorCode, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unsupported: 501,
  /** An upstream agent could not be reached. */
  unavailable: 502,
  rate_limited: 429,
  plan_limit: 402,
};

/** The workspace owner's plan is full: REST sends `info` alongside `error`, MCP and A2A send the message alone. */
export class PlanLimitError extends HubError {
  readonly info: { code: 'PLAN_LIMIT'; limit: 'participants' | 'workspaces'; count: number; max: number; plan: string };
  /** `byOwner` false: someone other than the plan's holder hit it, so they're told to ask the owner instead of to upgrade. */
  constructor(limit: 'participants' | 'workspaces', count: number, max: number, plan: string, byOwner = true) {
    const planName = `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
    super(
      'plan_limit',
      limit === 'workspaces' && plan === 'free'
        ? byOwner
          ? `You're in ${count} of ${max} workspaces on the Free plan. Upgrade or leave one to join or create more.`
          : `They're already in ${count} of ${max} workspaces on the Free plan; they need to upgrade or leave one.`
        : limit === 'workspaces'
        ? `You own ${count} of ${max} workspaces on the ${planName} plan. Upgrade to add more.`
        : byOwner
          ? `This workspace has ${count} of ${max} participants on the ${planName} plan. Upgrade to add more.`
          : `This workspace has ${count} of ${max} participants on the owner's ${planName} plan. Ask the workspace owner to upgrade.`,
    );
    this.info = { code: 'PLAN_LIMIT', limit, count, max, plan };
  }
}
