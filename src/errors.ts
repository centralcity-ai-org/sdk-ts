import {
  RUNTIME_CONFLICTS,
  RUNTIME_REPLAY_CAPACITY_MESSAGE,
  defaultErrorPolicy,
  type ErrorKind,
  type ErrorPolicy,
} from './codes.js';
import { cleanServerText, type Untrusted } from './secret.js';

/** A field-level validation issue (no code; paths and constraints, never received values). */
export interface ValidationIssue {
  path: string;
  message: string;
}
/** A coded issue: manifest issues (QUOTA_EXCEEDED, …) and answer source issues (source_*). */
export interface CodedIssue {
  code: string;
  path: string;
  message: string;
  hint?: string;
}
export type Issue = ValidationIssue | CodedIssue;
export const isCodedIssue = (issue: Issue): issue is CodedIssue =>
  typeof (issue as CodedIssue).code === 'string';

export interface ErrorDetails {
  kind: ErrorKind;
  code: string;
  status: number | null;
  retryable: boolean;
  retryAfterMs?: number;
  issues?: Issue[];
  serverMessage: Untrusted<string>;
  requiredScopes?: string[];
  maybeApplied?: boolean;
}

/** Every error the SDK raises for a server answer. Never carries headers or bodies. */
export class CentralCityError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly issues: Issue[] | undefined;
  readonly serverMessage: Untrusted<string>;
  readonly requiredScopes: string[] | undefined;
  readonly maybeApplied: boolean | undefined;

  constructor(details: ErrorDetails) {
    super(`${details.code}${details.status ? ` (${details.status})` : ''}: ${details.serverMessage}`);
    this.name = 'CentralCityError';
    this.kind = details.kind;
    this.code = details.code;
    this.status = details.status;
    this.retryable = details.retryable;
    this.retryAfterMs = details.retryAfterMs;
    this.issues = details.issues;
    this.serverMessage = details.serverMessage;
    this.requiredScopes = details.requiredScopes;
    this.maybeApplied = details.maybeApplied;
  }
}

/** A network failure, timeout or unreadable response (no server verdict). */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** A JSON-RPC error inside a 2xx MCP response. */
export class ProtocolError extends Error {
  constructor(
    readonly rpcCode: number,
    message: Untrusted<string>,
  ) {
    super(`JSON-RPC ${rpcCode}: ${message}`);
    this.name = 'ProtocolError';
  }
}

/** Refused before sending (size, malformed input). */
export class LocalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalValidationError';
  }
}

function parseIssues(value: unknown): Issue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: Issue[] = [];
  for (const item of value.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const base = {
      path: cleanServerText(raw.path, 200),
      message: cleanServerText(raw.message),
    };
    if (typeof raw.code === 'string')
      issues.push({
        code: raw.code.slice(0, 64),
        ...base,
        ...(typeof raw.hint === 'string' ? { hint: cleanServerText(raw.hint) } : {}),
      });
    else issues.push(base);
  }
  return issues;
}

/** Seconds (Retry-After) or milliseconds (retry_after_ms) to a millisecond wait, if valid. */
function retryAfter(
  headerValue: string | null | undefined,
  retryAfterMs: unknown,
): number | undefined {
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0)
    return Math.ceil(retryAfterMs);
  if (headerValue && /^\d{1,7}$/.test(headerValue.trim()))
    return Number(headerValue.trim()) * 1000;
  return undefined;
}

/** `WWW-Authenticate: Bearer … error="insufficient_scope", scope="a b"` → required scopes. */
export function scopesFromChallenge(header: string | null | undefined): string[] | undefined {
  if (!header || !/error="insufficient_scope"/.test(header)) return undefined;
  const match = /scope="([^"]*)"/.exec(header);
  return match ? match[1]!.split(' ').filter(Boolean) : [];
}

function build(
  policy: ErrorPolicy,
  input: {
    code: string | null;
    status: number | null;
    message: unknown;
    issues?: Issue[];
    retryAfterMs?: number;
    requiredScopes?: string[];
  },
): CentralCityError {
  const issueCodes = (input.issues ?? []).filter(isCodedIssue).map((issue) => issue.code);
  const kind = input.requiredScopes
    ? 'scope'
    : policy.classify({ code: input.code, status: input.status, issueCodes });
  return new CentralCityError({
    kind,
    code: input.code ?? (kind === 'rate_limit' ? 'rate_limited' : `http_${input.status ?? 0}`),
    status: input.status,
    retryable: policy.retryable(kind),
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
    ...(input.issues ? { issues: input.issues } : {}),
    ...(input.requiredScopes ? { requiredScopes: input.requiredScopes } : {}),
    serverMessage: cleanServerText(input.message),
  });
}

/**
 * Shape 1: an MCP tool error. `content[0].text` is `{"error":{code,message,retryable,
 * retry_after_ms?,issues?}}`; an unreadable body becomes code `unknown`.
 */
export function fromToolError(
  result: { content?: Array<{ type?: string; text?: string }> },
  policy: ErrorPolicy = defaultErrorPolicy,
): CentralCityError {
  let error: Record<string, unknown> = {};
  const text = result.content?.[0]?.text ?? '';
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (parsed && typeof parsed.error === 'object' && parsed.error)
      error = parsed.error as Record<string, unknown>;
  } catch {
    // The MCP library's own input check answers in plain text ("Input validation error: …"),
    // before the server's coded handler: treat it as invalid_arguments. Else code unknown.
    if (/^Input validation error:/.test(text)) error = { code: 'invalid_arguments', message: text };
    else if (text) error = { message: text };
  }
  const code = typeof error.code === 'string' ? error.code : 'unknown';
  return build(policy, {
    code,
    status: null,
    message: error.message,
    ...(parseIssues(error.issues) ? { issues: parseIssues(error.issues)! } : {}),
    ...(retryAfter(null, error.retry_after_ms) !== undefined
      ? { retryAfterMs: retryAfter(null, error.retry_after_ms)! }
      : {}),
  });
}

/**
 * Shapes 2 and 3: a non-2xx HTTP answer from /mcp or REST. Bodies seen: `{error: "<message>",
 * code?, issues?}`, OAuth `{error, error_description}`, and a JSON-RPC `{error: {code, message}}`.
 * A 429 without a code is an ordinary rate limit (the generic limiter).
 */
export function fromHttpError(
  status: number,
  body: unknown,
  headers: { get(name: string): string | null },
  policy: ErrorPolicy = defaultErrorPolicy,
): CentralCityError {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  let code: string | null = typeof record.code === 'string' ? record.code : null;
  let message: unknown = record.error;
  if (typeof record.error_description === 'string') {
    code = code ?? (typeof record.error === 'string' ? record.error : null);
    message = record.error_description;
  } else if (record.error && typeof record.error === 'object') {
    message = (record.error as Record<string, unknown>).message;
  }
  if (code === null && status === 429 && message === RUNTIME_REPLAY_CAPACITY_MESSAGE)
    code = 'runtime_replay_capacity';
  if (code === null && status === 409 && typeof message === 'string') {
    const known = RUNTIME_CONFLICTS.find(([text]) => text === message);
    code = known ? known[1] : null;
  }
  const requiredScopes = scopesFromChallenge(headers.get('www-authenticate'));
  const issues = parseIssues(record.issues);
  const wait = retryAfter(headers.get('retry-after'), record.retry_after_ms);
  return build(policy, {
    code,
    status,
    message,
    ...(issues ? { issues } : {}),
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
    ...(requiredScopes && status === 403 ? { requiredScopes } : {}),
  });
}

/** Shape 4: an SSE `error` event `{status, code, message}` (code falls back to `rejected`). */
export function fromStreamError(
  data: unknown,
  policy: ErrorPolicy = defaultErrorPolicy,
): CentralCityError {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const status = typeof record.status === 'number' ? record.status : null;
  const raw = typeof record.code === 'string' ? record.code : null;
  // The generic fallbacks carry no meaning of their own: classify by status instead.
  const code = raw === 'rejected' || raw === 'internal_error' ? null : raw;
  return build(policy, { code, status, message: record.message });
}

/** Copies an error with `maybeApplied: true` (a keyless call's retry after an ambiguous failure). */
export function markMaybeApplied(error: CentralCityError): CentralCityError {
  return new CentralCityError({
    kind: error.kind,
    code: error.code,
    status: error.status,
    retryable: error.retryable,
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    ...(error.issues ? { issues: error.issues } : {}),
    ...(error.requiredScopes ? { requiredScopes: error.requiredScopes } : {}),
    serverMessage: error.serverMessage,
    maybeApplied: true,
  });
}

/**
 * A replayed creation returned `secrets_already_issued: true`: the first response held the only
 * copy of the key or claim secrets. Carries the non-secret fields of the replay.
 */
export class SecretsAlreadyIssuedError extends Error {
  constructor(
    readonly tool: string,
    readonly result: Record<string, unknown>,
  ) {
    super(
      `${tool}: the first response held the only copy of its secrets; create a new one with a new idempotency key.`,
    );
    this.name = 'SecretsAlreadyIssuedError';
  }
}

const RECONCILE: Record<string, string> = {
  city_create_workspace_key:
    'List the keys (keys.list) and revoke any you do not recognise.',
  city_create_invite: 'List the invites (connections.listInvites) and revoke any you do not recognise.',
  city_set_wake_webhook:
    'Call webhooks.set once more and use only the new secret; the unseen one is already invalid.',
  city_room_renew:
    'The old credential may already be replaced: ask the room host for a rejoin link for your member.',
};

/** A never-retried call failed after it may have reached the server. */
export class AmbiguousResultError extends Error {
  constructor(
    readonly tool: string,
    readonly cause?: unknown,
  ) {
    super(
      `${tool} may or may not have been applied, and it is never retried. ${RECONCILE[tool] ?? 'Check the current state before calling it again.'}`,
    );
    this.name = 'AmbiguousResultError';
  }
}

/** The tool is not offered on this endpoint or by this server version. */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedError';
  }
}
