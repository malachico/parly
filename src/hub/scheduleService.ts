import { HubError } from '../lib/errors.js';
import { isPublicWorkspace, type AgentRecord } from '../registry/types.js';
import type { HubService } from './hubService.js';
import { parseSpec, type ScheduleRecord } from './schedules.js';

/** A scheduled message's text, checked. */
function scheduleText(v: unknown): string {
  const text = typeof v === 'string' ? v.trim() : '';
  if (!text) throw new HubError('invalid', 'Say what to post: text');
  if (text.length > 4000) throw new HubError('invalid', 'A scheduled message is up to 4000 characters');
  return text;
}

/**
 * Scheduled messages: creating, listing, editing, and firing due channel/agent schedules.
 */
export class ScheduleService {
  constructor(private readonly hub: HubService) {}

  private get registry() {
    return this.hub.registry;
  }
  private get chat() {
    return this.hub.chat;
  }
  private get schedules() {
    return this.hub.schedules;
  }
  private get talks() {
    return this.hub.talks;
  }

  /**
   * Schedules a message in a channel the caller is in (a person, or an agent for its owner): posted as that person,
   * with ⏰ in front, when its time comes. `@Name` in it wakes that agent like any post. (No bot: a schedule is a
   * message waiting for its time, not a member of the team.)
   */
  async createSchedule(caller: AgentRecord, channelId: string, body: Record<string, unknown>): Promise<ScheduleRecord> {
    const person = await this.personOf(caller);
    const channel = await this.registry.resolveMemberChannel(caller, channelId);
    const workspace = await this.registry.workspaceById(channel.workspaceId);
    if (isPublicWorkspace(workspace)) {
      await this.registry.requireChannelOwner(caller, channel.id);
    }
    const text = scheduleText(body.text);
    const spec = parseSpec(body);
    if (!(person.channels ?? []).includes(channel.id)) throw new HubError('forbidden', `${person.name} isn't in #${channel.name}, so a message can't be scheduled there as them`);
    const thread = typeof body.thread === 'string' && body.thread ? body.thread : undefined;
    // The person it's for owns it, also when their agent made it: they change it in the panel, their agents with the tools.
    return this.schedules.create({ ...spec, channelId: channel.id, ...(thread ? { thread } : {}), text, ownerId: person.id });
  }

  /**
   * Schedules a direct message to an agent, sent as the person (the caller, or the agent's owner) with ⏰ in front, so
   * the agent's answer lands in their own conversation with it.
   */
  async createAgentSchedule(caller: AgentRecord, to: string, body: Record<string, unknown>): Promise<ScheduleRecord> {
    const person = await this.personOf(caller);
    const agent = await this.registry.requireVisible(to, person);
    if (agent.id === person.id) throw new HubError('invalid', "You can't schedule a message to yourself; schedule it in a channel");
    if (agent.webhookChannel) throw new HubError('invalid', `${agent.name} only posts; it can't receive messages`);
    await this.chat.refusePrivate(person, agent);
    return this.schedules.create({ ...parseSpec(body), to: agent.id, text: scheduleText(body.text), ownerId: person.id });
  }

  /** What the caller's person has scheduled to send an agent. */
  async agentSchedules(caller: AgentRecord, to: string): Promise<ScheduleRecord[]> {
    return this.schedules.toAgent((await this.personOf(caller)).id, to);
  }

  /** Everything the caller's person has scheduled (in channels and to agents): the "On a schedule" triggers. */
  async mySchedules(caller: AgentRecord): Promise<ScheduleRecord[]> {
    return this.schedules.ofOwner((await this.personOf(caller)).id);
  }

  /** The person a schedule is for: the caller, or the owner of an agent caller. */
  private async personOf(caller: AgentRecord): Promise<AgentRecord> {
    const person = caller.kind === 'human' ? caller : caller.ownerId ? await this.registry.get(caller.ownerId) : undefined;
    if (!person || person.kind !== 'human') throw new HubError('forbidden', 'An agent schedules messages for the person who owns it, and this one has no owner');
    return person;
  }

  /** A channel's scheduled messages, for its members. */
  async channelSchedules(caller: AgentRecord, channelId: string): Promise<ScheduleRecord[]> {
    const channel = await this.registry.resolveMemberChannel(caller, channelId);
    return this.schedules.ofChannel(channel.id);
  }

  /**
   * Its owner (or one of their agents) or a channel owner changes a scheduled message: `{active}` pauses or resumes it; `text` and/or a new
   * timing (`repeat` and its fields) edit it; null deletes it.
   */
  async changeSchedule(caller: AgentRecord, id: string, change: Record<string, unknown> | null): Promise<ScheduleRecord | undefined> {
    const s = await this.schedules.get(id);
    if (!s) throw new HubError('not_found', `No scheduled message ${id}`);
    const mine = s.ownerId === caller.id || (caller.kind !== 'human' && caller.ownerId === s.ownerId);
    if (s.channelId) {
      await this.registry.resolveMemberChannel(caller, s.channelId);
      if (!mine) await this.registry.requireChannelOwner(caller, s.channelId);
    } else if (!mine) throw new HubError('not_found', `No scheduled message ${id}`);
    if (change === null) return void (await this.schedules.remove(id));
    let out = s;
    if (change.text !== undefined || change.repeat !== undefined) {
      out = await this.schedules.update(out, {
        ...(change.text !== undefined ? { text: scheduleText(change.text) } : {}),
        ...(change.repeat !== undefined ? { spec: parseSpec({ tz: s.tz, ...change }) } : {}),
      });
    }
    if (typeof change.active === 'boolean' && change.active !== out.active) out = await this.schedules.setActive(out, change.active);
    return out;
  }

  /** Posts the scheduled messages that are due (POST /tick every minute, and each instance's sweep). */
  async runSchedules(now = new Date()): Promise<number> {
    const posted = await this.schedules.runDue(async (s) => {
      // As whoever scheduled it, marked ⏰: to an agent (its answer lands in their conversation with it), or in a channel.
      const person = await this.registry.get(s.ownerId);
      if (!person) throw new Error('Whoever scheduled it is gone');
      const text = [{ text: `⏰ ${s.text}` }];
      const to = s.to ? { dm: s.to } : { channelId: s.channelId!, ...(s.thread ? { thread: s.thread } : {}) };
      await this.chat.post(person, to, { parts: text, meta: { scheduled: true } });
    }, now);
    await this.talks.remind(now).catch((err) => console.error('room reminders failed', err));
    return posted;
  }
}
