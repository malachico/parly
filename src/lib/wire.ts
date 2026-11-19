import { randomUUID } from 'node:crypto';

/**
 * A2A v1.0 objects in their JSON wire form (what goes over JSON-RPC). The SDK's proto types are only used
 * at the A2A transport boundary, via `Task.fromJSON` / `Message.toJSON`. Messages are stored as their parts.
 */

type TaskStateName =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

type RoleName = 'ROLE_USER' | 'ROLE_AGENT';

export interface WirePart {
  text?: string;
  data?: unknown;
  url?: string;
  raw?: string;
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

export interface WireMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: RoleName;
  parts: WirePart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

interface WireArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: WirePart[];
  metadata?: Record<string, unknown>;
}

export interface WireTask {
  id: string;
  contextId: string;
  status: { state: TaskStateName; message?: WireMessage; timestamp?: string };
  artifacts?: WireArtifact[];
  history?: WireMessage[];
  metadata?: Record<string, unknown>;
}

export function newId(): string {
  return randomUUID();
}

export function buildParts(text?: string, data?: unknown): WirePart[] {
  const parts: WirePart[] = [];
  if (text !== undefined && text !== '') parts.push({ text });
  if (data !== undefined) parts.push({ data });
  return parts;
}

export function textOf(message: Pick<WireMessage, 'parts'> | undefined): string {
  if (!message) return '';
  return message.parts
    .map((p) => p.text)
    .filter((t): t is string => typeof t === 'string')
    .join('\n');
}

export function nowIso(): string {
  return new Date().toISOString();
}
