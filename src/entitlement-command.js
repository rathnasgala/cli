import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'yaml';
import { readGalaCredential } from './gala-credential-store.js';
import { fetchAttributionEntitlement } from './entitlement-client.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ARTIFACT = '.gala/entitlement.json';

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

async function commitArtifact(root) {
  await runGit(root, ['add', '--', ARTIFACT]);
  await runGit(root, ['commit', '--message', 'chore(gala): update attribution entitlement', '--', ARTIFACT]);
  await runGit(root, ['push']);
}

export async function acquireAttributionEntitlement({
  root = process.cwd(), readCredential = readGalaCredential,
  fetchEntitlement = fetchAttributionEntitlement, commit = commitArtifact
} = {}) {
  const siteRoot = path.resolve(root);
  const configTarget = path.join(siteRoot, 'site.config.yml');
  const metadata = await lstat(configTarget);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError('site.config.yml must be a regular file');
  }
  const config = parse(await readFile(configTarget, 'utf8'));
  const siteId = config?.site?.id;
  if (!ULID.test(siteId)) throw new TypeError('site.config.yml site.id must be a canonical ULID');
  const artifact = await fetchEntitlement({ siteId, credential: await readCredential() });
  const directory = path.join(siteRoot, '.gala');
  await mkdir(directory, { recursive: true });
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new TypeError('.gala must be a real directory');
  }
  const target = path.join(siteRoot, ARTIFACT);
  try {
    const current = await lstat(target);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new TypeError('Attribution entitlement must be a regular file');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  try {
    if (await readFile(target, 'utf8') === serialized) return Object.freeze({ changed: false, siteId });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.gala-${process.pid}`;
  try {
    await writeFile(temporary, serialized, { flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await commit(siteRoot);
  return Object.freeze({ changed: true, siteId });
}
