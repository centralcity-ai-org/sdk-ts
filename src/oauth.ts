// OAuth 2.1 with PKCE S256 for /mcp. Public clients by default; confidential clients
// pass a `clientAssertion` signer (private_key_jwt, RFC 7523) and the SDK never sees the key.
import { base64, sha256Hex, utf8 } from './internal/bytes.js';
import { CentralCityError, TransportError, fromHttpError } from './errors.js';
import { Secret } from './secret.js';
import type { AuthProvider } from './transport.js';

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
}

export interface TokenSet {
  accessToken: Secret;
  refreshToken?: Secret;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** The granted scopes (the token response's `scope`), else the requested set. */
  scopes: string[];
}

/** Where tokens live. Production: a keychain or secret manager. One store per token family. */
export interface TokenStore {
  load(): Promise<TokenSet | undefined>;
  /** Must be durable before it resolves: refresh tokens rotate and a replay revokes the family. */
  save(tokens: TokenSet): Promise<void>;
}

export function memoryTokenStore(initial?: TokenSet): TokenStore {
  let current = initial;
  return {
    load: async () => current,
    save: async (tokens) => {
      current = tokens;
    },
  };
}

const base64url = (bytes: Uint8Array) =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE pair: a 43-character verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: Secret; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier: new Secret(verifier), challenge: base64url(digest) };
}

/** https everywhere, plain http only on loopback (local development). */
function secureOrigin(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TransportError(`The OAuth ${what} is not a URL.`);
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new TransportError(`The OAuth ${what} must use https (plain http only on loopback).`);
  if (url.username || url.password || url.hash)
    throw new TransportError(`The OAuth ${what} must not carry credentials or a fragment.`);
  return url;
}

/**
 * Refuses metadata whose issuer or endpoints (authorization, token, registration, revocation)
 * are not https (loopback excepted) or not on the issuer's own origin, or whose issuer is not the
 * expected origin. Otherwise a poisoned or plain-http token endpoint would receive the refresh
 * token and the PKCE verifier. Called by discover() and before every use of the metadata.
 */
export function validateMetadata(metadata: AuthorizationServerMetadata, origin?: string): AuthorizationServerMetadata {
  if (!metadata || typeof metadata !== 'object') throw new TransportError('OAuth metadata is missing.');
  const issuer = secureOrigin(metadata.issuer, 'issuer');
  if (origin !== undefined && issuer.origin !== secureOrigin(origin, 'origin').origin)
    throw new TransportError('The OAuth issuer does not match the origin.');
  const endpoints: Array<[string, string | undefined, boolean]> = [
    ['authorization endpoint', metadata.authorization_endpoint, true],
    ['token endpoint', metadata.token_endpoint, true],
    ['registration endpoint', metadata.registration_endpoint, false],
    ['revocation endpoint', metadata.revocation_endpoint, false],
  ];
  for (const [what, value, required] of endpoints) {
    if (value === undefined && !required) continue;
    if (typeof value !== 'string') throw new TransportError(`The OAuth ${what} is missing.`);
    if (secureOrigin(value, what).origin !== issuer.origin)
      throw new TransportError(`The OAuth ${what} is not on the issuer's origin.`);
  }
  return metadata;
}

export async function discover(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthorizationServerMetadata> {
  const url = new URL('/.well-known/oauth-authorization-server', secureOrigin(origin, 'origin'));
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'error', headers: { accept: 'application/json' } });
  } catch (error) {
    throw new TransportError('OAuth discovery did not complete.', error);
  }
  if (!response.ok) throw fromHttpError(response.status, null, response.headers);
  const metadata = (await response.json()) as AuthorizationServerMetadata;
  return validateMetadata(metadata, origin);
}

/** RFC 7591 registration of a public client; returns its client_id. */
export async function registerClient(
  metadata: AuthorizationServerMetadata,
  input: { clientName: string; redirectUris: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  validateMetadata(metadata);
  if (!metadata.registration_endpoint) throw new TransportError('No registration endpoint.');
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const body = (await response.json().catch(() => null)) as { client_id?: string } | null;
  if (!response.ok || !body?.client_id) throw fromHttpError(response.status, body, response.headers);
  return body.client_id;
}

/**
 * OAuth `state`: the caller generates it with newState() before redirecting, stores it (for
 * example in the session), and on the callback checks the returned value with checkState()
 * before exchanging the code. The SDK does not keep it for you.
 */
export function newState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

export function checkState(expected: string, received: string | null | undefined): boolean {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

export function authorizationUrl(
  metadata: AuthorizationServerMetadata,
  input: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    challenge: string;
    origin: string;
  },
): string {
  validateMetadata(metadata, input.origin);
  if (!input.state || input.state.length < 16)
    throw new TypeError('Pass an unguessable state (newState()) and check it on the callback (checkState()).');
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(' '),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    resource: new URL('/mcp', input.origin).toString(),
  }).toString();
  return url.toString();
}

export interface ClientAuth {
  clientId: string;
  /** For private_key_jwt: returns a fresh signed assertion for the token endpoint audience. */
  clientAssertion?: (audience: string) => Promise<string>;
}

async function tokenRequest(
  metadata: AuthorizationServerMetadata,
  client: ClientAuth,
  params: Record<string, string>,
  requested: string[],
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  validateMetadata(metadata);
  const form = new URLSearchParams({ ...params, client_id: client.clientId });
  if (client.clientAssertion) {
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    form.set('client_assertion', await client.clientAssertion(metadata.token_endpoint));
  }
  let response: Response;
  try {
    response = await fetchImpl(metadata.token_endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
  } catch (error) {
    throw new TransportError('The token request did not complete.', error);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body || typeof body.access_token !== 'string')
    throw fromHttpError(response.status, body, response.headers);
  return {
    accessToken: new Secret(body.access_token),
    ...(typeof body.refresh_token === 'string' ? { refreshToken: new Secret(body.refresh_token) } : {}),
    ...(typeof body.expires_in === 'number' ? { expiresAt: Date.now() + body.expires_in * 1000 } : {}),
    // A server that omits scope is treated as granting the requested set.
    scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : requested,
  };
}

export function exchangeCode(
  metadata: AuthorizationServerMetadata,
  client: ClientAuth,
  input: { code: string; verifier: Secret; redirectUri: string; origin: string; scopes: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  return tokenRequest(
    metadata,
    client,
    {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.verifier.reveal(),
      redirect_uri: input.redirectUri,
      resource: new URL('/mcp', input.origin).toString(),
    },
    input.scopes,
    fetchImpl,
  );
}

/**
 * An AuthProvider over a TokenStore. Refreshes shortly before expiry and once after a 401, with
 * one refresh in flight per provider: a refresh token is single-use, and replaying it revokes
 * the whole family. The new pair is saved before it is used.
 *
 * Single-flight is per provider object, in one process. If several processes (or workers) share
 * one token family, they must serialise refreshes themselves, for example with a lock around
 * TokenStore load-refresh-save; otherwise two of them can refresh with the same refresh token and
 * the server revokes the family.
 */
export class OAuthProvider implements AuthProvider {
  readonly #metadata: AuthorizationServerMetadata;
  readonly #client: ClientAuth;
  readonly #store: TokenStore;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  #refreshing: Promise<TokenSet> | undefined;
  #scopes: string[] | undefined;

  constructor(options: {
    /** Validated here: https (loopback excepted) and every endpoint on the issuer's origin. */
    metadata: AuthorizationServerMetadata;
    client: ClientAuth;
    store: TokenStore;
    origin: string;
    fetch?: typeof fetch;
  }) {
    this.#metadata = validateMetadata(options.metadata, options.origin);
    this.#client = options.client;
    this.#store = options.store;
    this.#origin = options.origin;
    this.#fetch = options.fetch ?? fetch;
  }

  /** The granted scopes, once tokens are loaded. */
  get grantedScopes(): readonly string[] | undefined {
    return this.#scopes;
  }

  async header(): Promise<string | undefined> {
    let tokens = await this.#store.load();
    if (!tokens) throw new TransportError('No OAuth tokens: run the authorization flow first.');
    if (tokens.expiresAt !== undefined && tokens.expiresAt - Date.now() < 30_000 && tokens.refreshToken)
      tokens = await this.refresh();
    this.#scopes = tokens.scopes;
    return `Bearer ${tokens.accessToken.reveal()}`;
  }

  /** Called by the client after a 401: one refresh, then the caller fails. */
  async refresh(): Promise<TokenSet> {
    this.#refreshing ??= (async () => {
      try {
        const current = await this.#store.load();
        if (!current?.refreshToken) throw new TransportError('No refresh token.');
        const next = await tokenRequest(
          this.#metadata,
          this.#client,
          {
            grant_type: 'refresh_token',
            refresh_token: current.refreshToken.reveal(),
            resource: new URL('/mcp', this.#origin).toString(),
          },
          current.scopes,
          this.#fetch,
        );
        await this.#store.save(next);
        this.#scopes = next.scopes;
        return next;
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }
}

export const isAuthError = (error: unknown) =>
  error instanceof CentralCityError && error.kind === 'auth';

/** A stable, non-secret fingerprint for logs and hooks. */
export const fingerprint = async (value: string) => (await sha256Hex(utf8(value))).slice(0, 12);
