import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function githubCredentialPath({ platform = process.platform, environment = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    if (!environment.APPDATA) throw new Error('APPDATA is required to store GitHub credentials on Windows');
    return path.join(environment.APPDATA, 'Gala', 'github-credentials.json');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Gala', 'github-credentials.json');
  return path.join(environment.XDG_CONFIG_HOME || path.join(home, '.config'), 'gala', 'github-credentials.json');
}

async function regularOrMissing(target) {
  try {
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new TypeError('GitHub credential must be a regular file');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writeGithubCredential({ accessToken, scopes, target = githubCredentialPath() }) {
  if (typeof accessToken !== 'string' || accessToken === '') throw new TypeError('accessToken is required');
  if (!Array.isArray(scopes) || !scopes.includes('repo') || !scopes.includes('workflow')) {
    throw new TypeError('GitHub credential requires repo and workflow scopes');
  }
  const directory = path.dirname(path.resolve(target));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new TypeError('GitHub credential directory must be a real directory');
  }
  await chmod(directory, 0o700);
  const exists = await regularOrMissing(target);
  const temporary = `${target}.gala-${process.pid}`;
  const backup = `${target}.gala-backup-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, accessToken, scopes })}\n`, {
      flag: 'wx', mode: 0o600
    });
    await chmod(temporary, 0o600);
    if (exists) await rename(target, backup);
    try { await rename(temporary, target); }
    catch (error) { if (exists) await rename(backup, target); throw error; }
    await chmod(target, 0o600);
    if (exists) await rm(backup);
    return path.resolve(target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function readGithubCredential({ target = githubCredentialPath() } = {}) {
  if (!await regularOrMissing(target)) throw new Error('GitHub authentication is missing; run `gala auth github`');
  const payload = JSON.parse(await readFile(target, 'utf8'));
  if (payload?.schemaVersion !== 1 || typeof payload.accessToken !== 'string'
      || !Array.isArray(payload.scopes) || !payload.scopes.includes('repo') || !payload.scopes.includes('workflow')) {
    throw new TypeError('GitHub credential file has an unsupported schema or missing scopes');
  }
  return Object.freeze({ accessToken: payload.accessToken, scopes: [...payload.scopes] });
}
