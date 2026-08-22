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

/**
 * Schema 2 stores a GitHub App user token, which has no scopes.
 *
 * Schema 1 held an OAuth App token and recorded the `repo` and `workflow` scopes it had negotiated.
 * A GitHub App has neither: its permissions are fixed on the app and granted at installation. The
 * version bump is what makes the difference visible — a schema-1 file is rejected on read, so a
 * writer carrying an OAuth token is sent through `auth github` once rather than presenting a
 * credential the API will refuse in a less obvious way later.
 */
export async function writeGithubCredential({
  accessToken, expiresAt, refreshToken, target = githubCredentialPath()
}) {
  if (typeof accessToken !== 'string' || accessToken === '') throw new TypeError('accessToken is required');
  if (expiresAt != null && Number.isNaN(new Date(expiresAt).getTime())) {
    throw new TypeError('expiresAt must be a date');
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
    const record = {
      schemaVersion: 2,
      accessToken,
      ...(expiresAt == null ? {} : { expiresAt: new Date(expiresAt).toISOString() }),
      ...(refreshToken == null ? {} : { refreshToken })
    };
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
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

export async function readGithubCredential({ target = githubCredentialPath(), now = new Date() } = {}) {
  if (!await regularOrMissing(target)) throw new Error('GitHub authentication is missing; run `gala auth github`');
  const payload = JSON.parse(await readFile(target, 'utf8'));
  if (payload?.schemaVersion === 1) {
    // An OAuth App token. It cannot list installations and organisations may refuse it outright, so
    // it is not usable — and saying that here beats a confusing 403 four calls later.
    throw new Error('GitHub authentication is out of date; run `gala auth github` again');
  }
  if (payload?.schemaVersion !== 2 || typeof payload.accessToken !== 'string'
      || payload.accessToken === '') {
    throw new TypeError('GitHub credential file has an unsupported schema');
  }
  /*
   * The app expires user tokens after eight hours. Refreshing one needs the app's client secret,
   * which lives on the server, so until that exchange exists the honest answer is to ask for a
   * sign-in here — rather than hand out a token that fails as a 401 several calls deeper, which is
   * exactly how the legacy Gala credential wasted a week.
   */
  if (typeof payload.expiresAt === 'string') {
    const expiresAt = new Date(payload.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
      throw new Error('GitHub authentication expired; run `gala auth github` again');
    }
    return Object.freeze({
      accessToken: payload.accessToken,
      expiresAt,
      ...(typeof payload.refreshToken === 'string' ? { refreshToken: payload.refreshToken } : {})
    });
  }
  return Object.freeze({ accessToken: payload.accessToken });
}
