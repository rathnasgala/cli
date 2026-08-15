import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'yaml';

import { readGalaCredential } from './gala-credential-store.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SNAPSHOT_PATH = '.engagement-snapshot.json';

async function runGit(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { shell: false, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`git terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`git ${args[0]} exited with code ${code}`));
      else resolve();
    });
  });
}

async function commitRefreshedSnapshot(root, relativePath) {
  await runGit(root, [
    'commit', '--only', '--message', 'chore(gala): refresh engagement snapshot', '--', relativePath
  ]);
  await runGit(root, ['push']);
}

function validateSnapshot(payload) {
  if (payload?.schemaVersion !== 1 || !UTC_INSTANT.test(payload.refreshedAt)
      || payload.articles == null || Array.isArray(payload.articles)
      || typeof payload.articles !== 'object') {
    throw new TypeError('Engagement snapshot response is invalid');
  }
  for (const [articleId, counts] of Object.entries(payload.articles)) {
    if (!ULID.test(articleId) || counts == null || Array.isArray(counts)
        || typeof counts !== 'object'
        || Object.keys(counts).sort().join(',') !== 'comments,reactions,views'
        || !['reactions', 'comments', 'views'].every(
          (field) => Number.isSafeInteger(counts[field]) && counts[field] >= 0
        )) {
      throw new TypeError('Engagement snapshot response is invalid');
    }
  }
  return payload;
}

async function requireRegularFile(target, label, { allowMissing = false } = {}) {
  try {
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new TypeError(`${label} must be a regular file`);
    }
    return true;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function refreshEngagementSnapshot({
  root = process.cwd(),
  readCredential = readGalaCredential,
  fetchImpl = fetch,
  commitSnapshot = commitRefreshedSnapshot
} = {}) {
  const siteRoot = path.resolve(root);
  const configPath = path.join(siteRoot, 'site.config.yml');
  await requireRegularFile(configPath, 'site.config.yml');
  const config = parse(await readFile(configPath, 'utf8'));
  const siteId = config?.site?.id;
  if (!ULID.test(siteId)) throw new TypeError('site.config.yml site.id must be a canonical ULID');

  const credential = await readCredential();
  const endpoint = new URL(`/v1/sites/${siteId}/engagement-snapshot`, credential.apiBaseUrl);
  const loopback = endpoint.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !loopback) || endpoint.username || endpoint.password) {
    throw new TypeError('Gala API URL must be credential-free HTTPS or HTTP loopback');
  }
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Engagement snapshot refresh failed with HTTP ${response.status}`);
  const snapshot = validateSnapshot(await response.json());
  const next = `${JSON.stringify(snapshot, null, 2)}\n`;
  const target = path.join(siteRoot, SNAPSHOT_PATH);
  const exists = await requireRegularFile(target, 'Engagement snapshot', { allowMissing: true });
  if (exists && await readFile(target, 'utf8') === next) return Object.freeze({ changed: false });

  const temporary = `${target}.gala-${process.pid}`;
  try {
    await writeFile(temporary, next, { flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await commitSnapshot(siteRoot, SNAPSHOT_PATH);
  return Object.freeze({ changed: true });
}
