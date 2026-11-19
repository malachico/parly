import {
  Message,
  Task,
  type AgentCard,
  type CancelTaskRequest,
  type GetTaskRequest,
  type ListTasksRequest,
  type ListTasksResponse,
  type SendMessageRequest,
  type StreamResponse,
  type TaskPushNotificationConfig,
} from '@a2a-js/sdk';
import {
  ExtendedAgentCardNotConfiguredError,
  PushNotificationNotSupportedError,
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';
import type { A2ARequestHandler, ServerCallContext, User } from '@a2a-js/sdk/server';
import type { MessageDoc } from '../chat/chat.js';
import type { HubService } from '../hub/hubService.js';
import { HubError } from '../lib/errors.js';
import type { WireMessage, WireTask } from '../lib/wire.js';
import type { AgentRecord } from '../registry/types.js';

/** A2A `User` carrying the authenticated hub agent. */
export class AgentUser implements User {
  constructor(readonly agent: AgentRecord) {}
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    return this.agent.name;
  }
}

/**
 * The hub's A2A surface over the chat. A "task" is a message: its id is the message id, its contextId the
 * conversation, and it's completed once someone answers it (its status message is the first answer).
 */
export class HubRequestHandler implements A2ARequestHandler {
  constructor(
    private readonly hub: HubService,
    private readonly card: AgentCard,
  ) {}

  async getAgentCard(): Promise<AgentCard> {
    return this.card;
  }

  async getAuthenticatedExtendedAgentCard(): Promise<AgentCard> {
    throw new ExtendedAgentCardNotConfiguredError();
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    const caller = callerOf(context);
    if (!params.message) throw new RequestMalformedError('message is required');
    const message = Message.toJSON(params.message) as WireMessage;
    const routing = { ...params.metadata, ...message.metadata };
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return run(async () => {
      // A message on a task (a message you can read) answers it; a channel post or a direct message otherwise.
      const sent = await this.hub.send(
        caller,
        message.taskId
          ? { replyTo: message.taskId }
          : { to: str(routing.to), skill: str(routing.skill), channel: str(routing.channel), thread: str(routing.thread), workspace: str(routing.workspace) },
        message.parts,
      );
      // Blocking send (the A2A default) to an agent: wait for its answer. A channel post's answers come as they do.
      const waits = !message.taskId && !routing.channel && !params.configuration?.returnImmediately;
      const reply = waits ? (await this.hub.chat.waitForReply(caller, sent.message.id, this.hub.maxWaitMs)).reply : undefined;
      return toTask(taskOf(sent.message, reply), params.configuration?.historyLength);
    });
  }

  // Stub generator: A2A interface requires AsyncGenerator; streaming unsupported.
  async *sendMessageStream(): AsyncGenerator<StreamResponse, void, undefined> {
    throw new UnsupportedOperationError('Streaming is not supported by the hub yet; use SendMessage');
  }

  async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    const caller = callerOf(context);
    return run(async () => {
      const { message, reply } = await this.hub.chat.waitForReply(caller, params.id, 0);
      return toTask(taskOf(message, reply), params.historyLength);
    });
  }

  /** What's new for the caller: per conversation, its newest message for them (answer it with SendMessage on its id). */
  async listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const caller = callerOf(context);
    const items = await run(() => this.hub.chat.newFor(caller));
    const tasks = items.slice(0, Math.min(params.pageSize || 50, 100)).map((i) => toTask(taskOf(i.message), params.historyLength));
    return { tasks, nextPageToken: '', pageSize: tasks.length, totalSize: items.length };
  }

  async cancelTask(_params: CancelTaskRequest): Promise<Task> {
    throw new TaskNotCancelableError('Messages are not canceled: send another one');
  }

  async createTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError();
  }
  async getTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    throw new PushNotificationNotSupportedError();
  }
  async listTaskPushNotificationConfigs(): Promise<never> {
    throw new PushNotificationNotSupportedError();
  }
  async deleteTaskPushNotificationConfig(): Promise<void> {
    throw new PushNotificationNotSupportedError();
  }

  // Stub generator: A2A interface requires AsyncGenerator; streaming unsupported.
  async *resubscribe(): AsyncGenerator<StreamResponse, void, undefined> {
    throw new UnsupportedOperationError('Streaming is not supported by the hub yet; poll GetTask');
  }
}

/** A message as an A2A task: submitted until someone answers it, then completed with that answer. */
function taskOf(m: MessageDoc, reply?: MessageDoc): WireTask {
  const wire = (x: MessageDoc): WireMessage => ({
    messageId: x.id,
    taskId: m.id,
    contextId: m.conversationId,
    role: x.fromId === m.fromId ? 'ROLE_USER' : 'ROLE_AGENT',
    parts: x.parts,
    metadata: { from: x.from, fromId: x.fromId, at: x.at },
  });
  return {
    id: m.id,
    contextId: m.conversationId,
    status: reply ? { state: 'TASK_STATE_COMPLETED', message: wire(reply), timestamp: reply.at } : { state: 'TASK_STATE_SUBMITTED', timestamp: m.at },
    history: [wire(m), ...(reply ? [wire(reply)] : [])],
    metadata: { conversation: m.conversationId, from: m.from, fromId: m.fromId },
  };
}

function callerOf(context: ServerCallContext): AgentRecord {
  const user = context.user;
  // The router rejects unauthenticated calls before they get here; this is a safety net.
  if (!(user instanceof AgentUser)) throw new RequestMalformedError('Authentication required');
  return user.agent;
}

function toTask(task: WireTask, historyLength?: number): Task {
  const view: WireTask = { ...task };
  if (historyLength !== undefined && view.history) view.history = historyLength === 0 ? [] : view.history.slice(-historyLength);
  return Task.fromJSON(view);
}

/** Maps HubErrors to the A2A errors the JSON-RPC layer knows how to encode. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof HubError)) throw err;
    switch (err.code) {
      case 'not_found':
        throw err.message.startsWith('Message') ? new TaskNotFoundError(err.message) : new RequestMalformedError(err.message);
      case 'unsupported':
        throw new UnsupportedOperationError(err.message);
      default:
        throw new RequestMalformedError(err.message);
    }
  }
}
