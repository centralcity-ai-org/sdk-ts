// Contract-test harness. Two ways to point it at a Central City app build:
//
//   CC_APP_DIR=/path/to/app-checkout   boots createApp() in this process on a random loopback
//                                      port, in memory (the app's `npm ci` must have run there)
//   CC_SDK_CONTRACT_ORIGIN=http://127.0.0.1:4391
//                                      uses an already running LOCAL server (fresh process
//                                      recommended: the suite creates workspaces and accounts,
//                                      and the per-address hourly limits apply)
//
// Only loopback origins are accepted: the suite registers synthetic accounts.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export interface Harness {
  origin: string;
  appDir: string | undefined;
  close(): Promise<void>;
}

let shared: Promise<Harness | null> | undefined;

export function harness(): Promise<Harness | null> {
  shared ??= boot();
  return shared;
}

async function boot(): Promise<Harness | null> {
  const appDir = process.env.CC_APP_DIR;
  const given = process.env.CC_SDK_CONTRACT_ORIGIN;
  if (given) {
    const url = new URL(given);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
      throw new Error('CC_SDK_CONTRACT_ORIGIN must be a loopback origin.');
    return { origin: url.origin, appDir, close: async () => {} };
  }
  if (!appDir) return null;
  process.env.CITY_INVITE_FLOW ??= '1';
  const { createApp } = (await import(pathToFileURL(`${appDir}/server/app.ts`).href)) as {
    createApp(options: object): Promise<{
      listen(o: object): Promise<string>;
      close(): Promise<void>;
      server: { address(): { port: number } };
    }>;
  };
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    origin: `http://127.0.0.1:${app.server.address().port}`,
    appDir,
    close: () => app.close(),
  };
}

/** A synthetic human owner on the local app (a browser session, for the consent page). */
export interface Owner {
  name: string;
  password: string;
  cookie: string;
}

export async function registerOwner(origin: string): Promise<Owner> {
  // Generated per run for the local test app only.
  const name = `SDK contract ${randomUUID().slice(0, 8)}`;
  const password = randomBytes(18).toString('base64url');
  const res = await fetch(new URL('/api/auth/register', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-city-request': '1' },
    body: JSON.stringify({ name, password }),
  });
  if (res.status !== 201) throw new Error(`register: ${res.status} ${await res.text()}`);
  const cookie = cookieFrom(res, 'cc_session');
  return { name, password, cookie };
}

export async function ownerPost(origin: string, owner: Owner, path: string, body: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(new URL(path, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-city-request': '1', cookie: owner.cookie, ...extra },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

function cookieFrom(res: Response, prefix: string): string {
  const all = res.headers.getSetCookie();
  const match = all.find((line) => line.startsWith(prefix));
  if (!match) throw new Error(`no ${prefix} cookie`);
  return match.split(';')[0]!;
}

/**
 * Drives the consent page like a browser: log in, tick `scopes`, approve. Returns the redirect's
 * code. Only the harness sends Origin (a browser would); the SDK never does.
 */
export async function consent(
  origin: string,
  owner: Owner,
  authorizeUrl: string,
  scopes: string[],
): Promise<{ code: string; state: string | null }> {
  const page = await fetch(authorizeUrl, { redirect: 'manual' });
  const html = await page.text();
  if (page.status !== 200) throw new Error(`authorize: ${page.status} ${html.slice(0, 300)}`);
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  const flow = page.headers.getSetCookie().find((line) => line.startsWith('cc_oauth_'))?.split(';')[0];
  if (!requestId || !csrf || !flow) throw new Error('consent form not found');
  const post = async (fields: Array<[string, string]>) => {
    const res = await fetch(new URL('/oauth/authorize', origin), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: flow, origin },
      body: new URLSearchParams([['request_id', requestId], ['csrf', csrf], ...fields]).toString(),
    });
    return { status: res.status, body: await res.text() };
  };
  const login = await post([
    ['action', 'login'],
    ['name', owner.name],
    ['password', owner.password],
  ]);
  if (login.status !== 200) throw new Error(`consent login: ${login.status} ${login.body.slice(0, 300)}`);
  const approved = await post([
    ['action', 'approve'],
    ...scopes.map((scope): [string, string] => ['scope', scope]),
    ['expires_in_days', '7'],
  ]);
  const target = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(approved.body)?.[1];
  if (!target) throw new Error(`consent approve: ${approved.status} ${approved.body.slice(0, 300)}`);
  const back = new URL(target.replaceAll('&amp;', '&'));
  const code = back.searchParams.get('code');
  if (!code) throw new Error('no code in the redirect');
  return { code, state: back.searchParams.get('state') };
}

/**
 * A second in-process app in hosted mode (CC_APP_DIR only): the open invite join accepts only a
 * canonical https link from the server's own origin, which a local-mode app never has. The app
 * believes it is https://127.0.0.1:<port>; the SDK still talks plain http on loopback.
 */
export async function hostedHarness(): Promise<(Harness & { publicOrigin: string }) | null> {
  const appDir = process.env.CC_APP_DIR;
  if (!appDir) return null;
  process.env.CITY_INVITE_FLOW ??= '1';
  // A throwaway local value for this in-process test app only.
  process.env.CITY_RATE_LIMIT_KEY ??= randomBytes(32).toString('base64url');
  const require = createRequire(`${appDir}/package.json`);
  const { PGlite } = (await import(pathToFileURL(require.resolve('@electric-sql/pglite')).href)) as {
    PGlite: { create(dir: string): Promise<unknown> };
  };
  const { createApp } = (await import(pathToFileURL(`${appDir}/server/app.ts`).href)) as {
    createApp(options: object): Promise<{ listen(o: object): Promise<string>; close(): Promise<void> }>;
  };
  const port = await freePort();
  const publicOrigin = `https://127.0.0.1:${port}`;
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: { databaseUrl: 'postgres://unused.invalid/test', publicOrigin, allowedOrigins: [publicOrigin] },
    startWorkers: false,
  });
  await app.listen({ host: '127.0.0.1', port });
  return { origin: `http://127.0.0.1:${port}`, publicOrigin, appDir, close: () => app.close() };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
