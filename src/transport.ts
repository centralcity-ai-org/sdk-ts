import { defaultErrorPolicy, type ErrorPolicy } from './codes.js';
import {
  LocalValidationError,
  ProtocolError,
  TransportError,
  fromHttpError,
  fromToolError,
} from './errors.js';
import { utf8 } from './internal/bytes.js';
import { cleanServerText } from './secret.js';
import { linkedSignal } from './internal/signals.js';
import { parseSse } from './sse.js';

/** Protocol revisions. Modern needs no initialize; legacy does. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSION = '2025-11-25';
/** The server refuses larger request bodies; the SDK refuses them before sending. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** Supplies `Authorization` for each attempt (open: none; key; OAuth with refresh). */
export interface AuthProvider {
  header(): Promise<string | undefined>;
}

/** The seam the rest of the SDK builds on; tests use a fake. */
export interface McpTransport {
  /** Calls a tool and returns its structuredContent, or throws CentralCityError. */
  callTool<T = unknown>(name: string, args: object, options?: CallOptions): Promise<T>;
  /** A raw JSON-RPC request (tools/list, server/discover, …). */
  request<T = unknown>(method: string, params?: object, options?: CallOptions): Promise<T>;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Per-attempt timeout; long-polls pass wait + 15 s. */
  timeoutMs?: number;
  /** Response cap for this call. */
  maxResponseBytes?: number;
}

export interface HttpTransportOptions {
  /** Full MCP endpoint, for example https://centralcity.ai/mcp/open or …/mcp. */
  endpoint: string;
  auth?: AuthProvider;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  clientInfo?: { name: string; version: string };
  /** 'modern' (default) sends the 2026-07-28 envelope; 'legacy' runs initialize first. */
  protocol?: 'modern' | 'legacy';
  errorPolicy?: ErrorPolicy;
}

type RpcResponse = {
  result?: unknown;
  error?: { code?: number; message?: string };
};
type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

function assertEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new LocalValidationError('Use an https endpoint (plain http only on loopback).');
  if (url.username || url.password || url.search || url.hash)
    throw new LocalValidationError('The endpoint must not carry credentials, a query or a fragment.');
  return url;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TransportError(`Response exceeded ${maxBytes} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * A small stateless Streamable HTTP client (not @modelcontextprotocol/client). No Origin header,
 * no redirects, one JSON-RPC message per POST, bodies capped before sending. Retries, budgets and
 * the per-tool retry table live above this layer.
 */
export class HttpMcpTransport implements McpTransport {
  readonly #endpoint: URL;
  readonly #options: Required<Pick<HttpTransportOptions, 'timeoutMs' | 'maxResponseBytes'>> &
    HttpTransportOptions;
  #nextId = 1;
  #initialized = false;

  constructor(options: HttpTransportOptions) {
    this.#endpoint = assertEndpoint(options.endpoint);
    this.#options = { timeoutMs: 30_000, maxResponseBytes: 1024 * 1024, ...options };
  }

  async callTool<T = unknown>(name: string, args: object, options: CallOptions = {}): Promise<T> {
    const result = (await this.request('tools/call', { name, arguments: args }, options, name)) as
      | ToolResult
      | undefined;
    if (!result || typeof result !== 'object') throw new TransportError('Empty tool result.');
    if (result.isError) throw fromToolError(result, this.#policy());
    // The same JSON also arrives as text in content[0]; structuredContent is authoritative.
    return result.structuredContent as T;
  }

  async request<T = unknown>(
    method: string,
    params: object = {},
    options: CallOptions = {},
    toolName?: string,
  ): Promise<T> {
    const modern = (this.#options.protocol ?? 'modern') === 'modern';
    if (!modern && !this.#initialized && method !== 'initialize') await this.#initialize(options);
    const clientInfo = this.#options.clientInfo ?? { name: '@centralcity/sdk', version: '0.0.0' };
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: this.#nextId++,
      method,
      params: modern
        ? {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientInfo': clientInfo,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          }
        : params,
    });
    if (utf8(body).byteLength > MAX_REQUEST_BYTES)
      throw new LocalValidationError(`Request body exceeds ${MAX_REQUEST_BYTES} bytes.`);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': modern ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION,
    };
    if (modern) {
      // The modern revision requires the method (and a tool's name) in headers matching the body.
      headers['mcp-method'] = method;
      if (toolName !== undefined) headers['mcp-name'] = toolName;
    }
    const authorization = await this.#options.auth?.header();
    if (authorization) headers.authorization = authorization;

    const linked = linkedSignal([options.signal], options.timeoutMs ?? this.#options.timeoutMs);
    const signal = linked.signal;
    try {
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(this.#endpoint, {
        method: 'POST',
        headers,
        body,
        redirect: 'error',
        signal,
      });
    } catch (error) {
      throw new TransportError('The request did not complete.', error);
    }
    const cap = options.maxResponseBytes ?? this.#options.maxResponseBytes;
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(await readCapped(response, 64 * 1024));
      } catch {
        parsed = null;
      }
      throw fromHttpError(response.status, parsed, response.headers, this.#policy());
    }
    let message: RpcResponse | undefined;
    if (type.startsWith('text/event-stream') && response.body) {
      for await (const event of parseSse(response.body, { maxBytes: cap })) {
        const candidate = JSON.parse(event.data) as RpcResponse & { method?: string };
        if ('result' in candidate || 'error' in candidate) {
          message = candidate;
          break;
        }
      }
    } else {
      try {
        message = JSON.parse(await readCapped(response, cap)) as RpcResponse;
      } catch (error) {
        if (error instanceof TransportError) throw error;
        throw new TransportError('The response was not JSON.', error);
      }
    }
    if (!message) throw new TransportError('No JSON-RPC response arrived.');
    if (message.error)
      throw new ProtocolError(message.error.code ?? 0, cleanServerText(message.error.message));
    return message.result as T;
    } finally {
      linked.dispose();
    }
  }

  async #initialize(options: CallOptions): Promise<void> {
    await this.request(
      'initialize',
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.#options.clientInfo ?? { name: '@centralcity/sdk', version: '0.0.0' },
      },
      options,
    );
    this.#initialized = true;
  }

  #policy(): ErrorPolicy {
    return this.#options.errorPolicy ?? defaultErrorPolicy;
  }
}

/** Bearer header from a fixed secret (workspace key); OAuth providers implement AuthProvider. */
export function bearer(token: { reveal(): string } | string): AuthProvider {
  return {
    header: async () => `Bearer ${typeof token === 'string' ? token : token.reveal()}`,
  };
}
