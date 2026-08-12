import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function galaCredentialPath({
  platform = process.platform,
  environment = process.env,
  home = os.homedir()
} = {}) {
  if (platform === 'win32') {
    const root = environment.APPDATA;
    if (!root) throw new Error('APPDATA is required to store Gala credentials on Windows');
    return path.join(root, 'Gala', 'credentials.json');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Gala', 'credentials.json');
  }
  const root = environment.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(root, 'gala', 'credentials.json');
}

async function regularOrMissing(target, label) {
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new TypeError(`${label} must be a regular file`);
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeGalaCredential({
  accessToken,
  expiresAt,
  apiBaseUrl,
  target = galaCredentialPath()
}) {
  if (typeof accessToken !== 'string' || accessToken === '') throw new TypeError('accessToken is required');
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new TypeError('expiresAt must be a valid Date');
  }
  const base = new URL(apiBaseUrl);
  const loopback = base.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !loopback) || base.username || base.password
      || base.search || base.hash) {
    throw new TypeError('apiBaseUrl must be credential-free HTTPS (or HTTP loopback) without query or fragment');
  }
  const directory = path.dirname(path.resolve(target));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new TypeError('Gala credential directory must be a real directory');
  }
  await chmod(directory, 0o700);
  const exists = await regularOrMissing(target, 'Gala credential file');
  const temporary = `${target}.gala-${process.pid}`;
  const backup = `${target}.gala-backup-${process.pid}`;
  const content = `${JSON.stringify({
    schemaVersion: 1,
    apiBaseUrl: base.href,
    accessToken,
    expiresAt: expiresAt.toISOString()
  })}\n`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    if (exists) await rename(target, backup);
    try {
      await rename(temporary, target);
    } catch (error) {
      if (exists) await rename(backup, target);
      throw error;
    }
    await chmod(target, 0o600);
    if (exists) await rm(backup);
    return path.resolve(target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readGalaCredential({ target = galaCredentialPath(), now = new Date() } = {}) {
  if (!await regularOrMissing(target, 'Gala credential file')) {
    throw new Error('Gala authentication is missing; run `gala auth`');
  }
  const payload = JSON.parse(await readFile(target, 'utf8'));
  if (payload?.schemaVersion !== 1 || typeof payload.accessToken !== 'string'
      || typeof payload.apiBaseUrl !== 'string' || typeof payload.expiresAt !== 'string') {
    throw new TypeError('Gala credential file has an unsupported schema');
  }
  const expiresAt = new Date(payload.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    throw new Error('Gala authentication expired; run `gala auth` again');
  }
  return Object.freeze({
    accessToken: payload.accessToken,
    apiBaseUrl: payload.apiBaseUrl,
    expiresAt
  });
}
