/**
 * Error-code policy.
 *
 * `kind` is the stable field to branch on. `code` is as specific as the server makes it: REST and
 * runtime errors carry the service's own code (for example `room_not_found`, `slug_taken`,
 * `task_claimed`), but MCP tool errors currently carry only the generic code for the status
 * (`invalid_arguments`, `not_found`, `conflict`, …) unless the service set one, so the same
 * condition can arrive with a specific code over REST and a generic one over MCP.
 *
 * Kept in one table, behind the ErrorPolicy interface,
 * because the server contract can still change: a change there edits this file,
 * not the parsers.
 */

export type ErrorKind =
  | 'auth'
  | 'scope'
  | 'forbidden'
  | 'approval_required'
  | 'not_found'
  | 'conflict'
  | 'paused'
  | 'quota_exceeded'
  | 'gone'
  | 'validation'
  | 'payload_too_large'
  | 'rate_limit'
  | 'capacity'
  | 'server'
  | 'unknown';

export interface ErrorPolicy {
  /** Classifies a server error; `issueCodes` are the codes of coded issues, if any. */
  classify(input: { code: string | null; status: number | null; issueCodes: string[] }): ErrorKind;
  /** Whether the SDK may retry after waiting (never decided by the server's own flag alone). */
  retryable(kind: ErrorKind): boolean;
}

/** 429 codes that are ordinary rate limits (wait and retry). Every other coded 429 is capacity. */
export const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'inbox_full',
  'remote_quota',
  'ask_timeout',
  'runtime_replay_capacity',
]);

/**
 * Coded capacity limits: permanent until something changes (never retried). Needed by name because
 * MCP tool errors carry no HTTP status; over HTTP any coded 429 outside RATE_LIMIT_CODES counts too.
 */
export const CAPACITY_CODES: ReadonlySet<string> = new Set([
  'too_many_rooms',
  'room_storage_full',
  'too_many_invites',
  'cooldown',
  'too_many_pending',
  'webhook_limit',
  'stream_limit',
  'publish_cap',
  'invite_capacity',
  'invite_host_capacity',
  'invite_source_capacity',
  'unclaimed_capacity',
]);

const BY_CODE: Record<string, ErrorKind> = {
  invalid_token: 'auth',
  unauthorized: 'auth',
  authorization_expired: 'auth',
  insufficient_scope: 'scope',
  forbidden: 'forbidden',
  connection_required: 'forbidden',
  agent_revoked: 'forbidden',
  removed_from_room: 'forbidden',
  read_only: 'forbidden',
  not_a_member: 'forbidden',
  host_required: 'forbidden',
  principal_ineligible: 'forbidden',
  room_credential_denied: 'forbidden',
  not_found: 'not_found',
  agent_not_found: 'not_found',
  room_not_found: 'not_found',
  member_not_found: 'not_found',
  request_not_found: 'not_found',
  invite_not_found: 'not_found',
  reply_not_found: 'not_found',
  invite_invalid: 'not_found',
  result_not_found: 'not_found',
  conflict: 'conflict',
  idempotency_conflict: 'conflict',
  room_closed: 'conflict',
  room_full: 'conflict',
  slug_taken: 'conflict',
  agent_limit: 'conflict',
  pending_exists: 'conflict',
  not_pending: 'conflict',
  publish_conflict: 'conflict',
  join_already_completed: 'conflict',
  task_claimed: 'conflict',
  claim_stale: 'conflict',
  agent_paused: 'paused',
  workspace_paused: 'paused',
  runtime_paused: 'paused',
  gone: 'gone',
  message_expired: 'gone',
  invalid_arguments: 'validation',
  invalid_request: 'validation',
  cannot_remove_host: 'validation',
  ack_beyond_latest: 'validation',
  invalid_webhook_url: 'validation',
  room_credential_required: 'validation',
  credential_in_message: 'validation',
  same_workspace: 'validation',
  too_large: 'payload_too_large',
  message_too_large: 'payload_too_large',
  internal_error: 'server',
};

const BY_STATUS: Record<number, ErrorKind> = {
  400: 'validation',
  401: 'auth',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  415: 'validation',
};

export const defaultErrorPolicy: ErrorPolicy = {
  classify({ code, status, issueCodes }) {
    if (issueCodes.some((c) => c === 'OWNER_APPROVAL_REQUIRED' || c === 'UNCLAIMED_ZERO_COST_ONLY'))
      return 'approval_required';
    if (status === 409 && issueCodes.length > 0 && issueCodes.every((c) => c === 'QUOTA_EXCEEDED'))
      return 'quota_exceeded';
    if (code !== null && CAPACITY_CODES.has(code)) return 'capacity';
    // 429: a code outside the allowlist is capacity; no code at all is an ordinary rate limit.
    if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code)))
      return code === null || RATE_LIMIT_CODES.has(code) ? 'rate_limit' : 'capacity';
    if (code !== null && BY_CODE[code]) return BY_CODE[code]!;
    if (status !== null && status >= 500) return 'server';
    if (status !== null && BY_STATUS[status]) return BY_STATUS[status]!;
    return 'unknown';
  },
  retryable(kind) {
    return kind === 'rate_limit' || kind === 'server';
  },
};

/** Runtime 409s carry no code; their exact messages map to stable sub-codes. */
export const RUNTIME_CONFLICTS: ReadonlyArray<[message: string, code: string]> = [
  ['Heartbeat sequence must increase.', 'runtime_sequence_stale'],
  ['Send a heartbeat before claiming work.', 'runtime_heartbeat_required'],
  ['Job lease is invalid.', 'runtime_lease_invalid'],
  ['Job is not running under this lease.', 'runtime_lease_invalid'],
  ['A different result was already submitted.', 'runtime_result_conflict'],
  ['Workspace is paused. Retry after it resumes.', 'runtime_paused'],
  ['Runtime request was already used.', 'runtime_nonce_replayed'],
];

/** The runtime's uncoded 429 for a full replay-nonce store. */
export const RUNTIME_REPLAY_CAPACITY_MESSAGE = 'Runtime replay capacity reached.';
