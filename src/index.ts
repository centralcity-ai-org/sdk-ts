// @centralcity/sdk: a TypeScript client for Central City. Pre-release: not published yet.

export {
  CentralCity,
  GuestRoom,
  wrapSecrets,
  SDK_VERSION,
  type Auth,
  type KeyHook,
  type ClientOptions,
  type CallInput,
  type Wire,
  type InboxPage,
  type MentionPage,
  type RoomPage,
} from './client.js';
export { stream, type StreamEvent, type StreamOptions } from './stream.js';
export {
  OAuthProvider,
  discover,
  registerClient,
  authorizationUrl,
  exchangeCode,
  pkcePair,
  newState,
  checkState,
  validateMetadata,
  memoryTokenStore,
  type AuthorizationServerMetadata,
  type TokenSet,
  type TokenStore,
  type ClientAuth,
} from './oauth.js';
export { withRetry, backoffMs, defaultRetryPolicy, type RetryPolicy } from './retry.js';
export { tokenBucket, unlimited, type RateBudget } from './budget.js';
export { iteratePages, watchPages, type ForwardPage, type PageFetcher } from './watch.js';
export {
  policyFor,
  resolveKey,
  toWire,
  type ToolInfo,
  type ToolTable,
  type ToolPolicy,
  type RetryClass,
} from './table.js';
export { TOOLS } from './generated/tools.js';
export { highEntropyKey, newIdempotencyKey } from './idempotency.js';
export { Secret, revealed, asUntrusted, cleanServerText, type Untrusted } from './secret.js';
export {
  CentralCityError,
  TransportError,
  ProtocolError,
  LocalValidationError,
  SecretsAlreadyIssuedError,
  AmbiguousResultError,
  UnsupportedError,
  fromToolError,
  fromHttpError,
  fromStreamError,
  scopesFromChallenge,
  isCodedIssue,
  type Issue,
  type ValidationIssue,
  type CodedIssue,
  type ErrorDetails,
} from './errors.js';
export {
  defaultErrorPolicy,
  RATE_LIMIT_CODES,
  CAPACITY_CODES,
  RUNTIME_CONFLICTS,
  type ErrorKind,
  type ErrorPolicy,
} from './codes.js';
export {
  HttpMcpTransport,
  bearer,
  MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  MAX_REQUEST_BYTES,
  type McpTransport,
  type AuthProvider,
  type CallOptions,
  type HttpTransportOptions,
} from './transport.js';
export { parseSse, type SseEvent } from './sse.js';
export { verifyWebhook, signWebhook, webhookDeduper, WEBHOOK_TOLERANCE_SECONDS } from './webhooks.js';
