import { chmod, mkdir, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Where credentials live, and the rules for reading them.
 *
 * Two rules matter more than the storage itself, both learned the hard way:
 *
 * A credential is only valid if the server still accepts it. v0 checked expiry and nothing else, so
 * a token the API had already decided to refuse - it stopped issuing a claim these carried - was
 * handed out for weeks, and every command failed as an unexplained 401 several calls deep.
 *
 * A credential whose shape has changed is not upgradable in place. Bumping `schemaVersion` and
 * refusing the old one sends the writer through one sign-in, which is the only honest answer.
 *
 * Plaintext at 0600 protects against other users and stray backups, not against anything running
 * as the writer. Moving to the OS keychain is tracked separately; the file stays as the fallback
 * for platforms without one.
 */
const SCHEMA_VERSION = 2;

export function credentialPath(name, { platform = process.platform, environment = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    if (!environment.APPDATA) throw new Error('APPDATA is required to store credentials on Windows');
    return path.join(environment.APPDATA, 'Gala', `${name}.json`);
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Gala', `${name}.json`);
  }
  return path.join(environment.XDG_CONFIG_HOME || path.join(home, '.config'), 'gala', `${name}.json`);
}

export async function writeCredential(target, record) {
  const directory = path.dirname(path.resolve(target));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await refuseSymbolicLink(target);

  const temporary = `${target}.gala-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...record })}\n`, {
      flag: 'wx', mode: 0o600
    });
    await chmod(temporary, 0o600);
    // Renaming over the target is what makes a half-written credential impossible.
    await rename(temporary, target);
    return path.resolve(target);
  } catch (failure) {
    await rm(temporary, { force: true });
    throw failure;
  }
}

/** Returns null when there is nothing usable, so callers branch on presence rather than on errors. */
export async function readCredential(target, { now = new Date() } = {}) {
  let payload;
  try {
    await refuseSymbolicLink(target);
    payload = JSON.parse(await readFile(target, 'utf8'));
  } catch (missing) {
    if (missing?.code === 'ENOENT') return null;
    if (missing instanceof SyntaxError) return null;
    throw missing;
  }
  if (payload?.schemaVersion !== SCHEMA_VERSION) return null;
  if (typeof payload.accessToken !== 'string' || payload.accessToken === '') return null;
  if (typeof payload.expiresAt === 'string') {
    const expiresAt = new Date(payload.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) return null;
  }
  return payload;
}

export async function forgetCredential(target) {
  await rm(target, { force: true });
}

async function refuseSymbolicLink(target) {
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError('Credential must be a regular file');
    }
  } catch (missing) {
    if (missing?.code !== 'ENOENT') throw missing;
  }
}
