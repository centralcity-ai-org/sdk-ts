// Node-only helpers (node: imports): a durable, single-writer heartbeat sequence file.
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { SequenceStore } from '../runtime/sequence.js';

const WINDOWS = process.platform === 'win32';

/**
 * The per-user directory for runtime state (override with CC_SDK_STATE_DIR): `%LOCALAPPDATA%\CentralCity` on Windows (inside the
 * user profile), `~/.central-city` elsewhere.
 */
export function defaultStateDirectory(): string {
  if (process.env.CC_SDK_STATE_DIR) return resolve(process.env.CC_SDK_STATE_DIR);
  if (WINDOWS) return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'CentralCity');
  return join(homedir(), '.central-city');
}

/** The default sequence file for an agent, inside {@link defaultStateDirectory}. */
export function defaultSequencePath(agentId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(agentId)) throw new TypeError('Invalid agent id.');
  return join(defaultStateDirectory(), `${agentId}.sequence`);
}

/**
 * A sequence file with a lock file (`<file>.lock`, exclusive create), written 0600 with fsync and
 * an atomic rename, the next value persisted before it is returned. Refuses symlinks. Only one
 * process may hold it; after a crash, delete the stale lock file once no connector runs.
 *
 * Permissions: on POSIX the directory is 0700 and the files 0600 (set explicitly, whatever the
 * umask). Windows has no POSIX modes: the files inherit the ACLs of their directory, so keep them
 * inside the user profile (the default, {@link defaultSequencePath}), not in a shared folder.
 */
export async function fileSequenceStore(file: string): Promise<SequenceStore & { close(): Promise<void> }> {
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // The SDK's own state directory is tightened even when it already existed (mkdir's mode only
  // applies on creation). A directory you chose is left as it is: its permissions are yours.
  if (!WINDOWS && resolve(dirname(path)) === resolve(defaultStateDirectory())) await chmod(dirname(path), 0o700);
  const restrict = async (target: string) => {
    if (!WINDOWS) await chmod(target, 0o600);
  };
  for (const candidate of [path, `${path}.lock`]) {
    const info = await lstat(candidate).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error(`Refusing a symlink: ${candidate}`);
  }
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    throw new Error('Cannot acquire the sequence lock: another connector holds it (or a stale lock file remains).');
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await restrict(lockPath);
  let value = -1;
  let closed = false;
  const release = async () => {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  };
  try {
    const handle = await open(path, 'r');
    try {
      if ((await handle.stat()).size > 64) throw new Error('Sequence file is invalid.');
      const content = (await handle.readFile('utf8')).trim();
      const n = Number(content);
      if (!/^\d+$/.test(content) || !Number.isSafeInteger(n)) throw new Error('Sequence file is invalid.');
      value = n;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await release();
      throw error;
    }
  }
  return {
    async next() {
      if (closed) throw new Error('Sequence store is closed.');
      const next = value + 1;
      if (!Number.isSafeInteger(next)) throw new Error('Sequence exhausted; rotate credentials.');
      const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(String(next));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await restrict(temporary);
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      value = next;
      return next;
    },
    async close() {
      if (closed) return;
      closed = true;
      await release();
    },
  };
}
