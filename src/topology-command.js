import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { spawn } from 'node:child_process';
import { readGalaCredential } from './gala-credential-store.js';
import { readGithubCredential } from './github-credential-store.js';
import { writeRegisteredSiteConfiguration } from './site-config-registration.js';
import { prepareTopologyChange, commitTopologyChange } from './topology-client.js';
import { provisionGithubPages } from './github-pages-provisioning.js';

function run(root, args, spawnProcess, accepted = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('git', ['-C', root, ...args], { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Git ${args[0]} terminated by signal ${signal}`));
      else if (!accepted.includes(code)) reject(new Error(`Git ${args[0]} exited with code ${code}`));
      else resolve({ code, output: output.trim() });
    });
  });
}

export async function switchTopology({
  root, owner, repository, canonicalBaseUrl, pathPrefix = '/',
  readGala = readGalaCredential, readGithub = readGithubCredential,
  prepare = prepareTopologyChange, commit = commitTopologyChange,
  provisionPages = provisionGithubPages, spawnProcess = spawn
}) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(owner)
      || typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new TypeError('owner and repository are required GitHub path segments');
  }
  const siteRoot = path.resolve(root);
  const config = parse(await readFile(path.join(siteRoot, 'site.config.yml'), 'utf8'));
  const siteId = config?.site?.id;
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(siteId)) throw new TypeError('site.config.yml has no valid site id');
  const [gala, github] = await Promise.all([readGala(), readGithub()]);
  const pending = await prepare({
    apiBaseUrl: gala.apiBaseUrl, accessToken: gala.accessToken, siteId, canonicalBaseUrl, pathPrefix
  });
  // A site served under a path holds no domain of its own — GitHub lends it the one on the
  // owner's main site — so the absence of a cname no longer means the provider address.
  const topology = pending.canonicalBaseUrl === `https://${owner.toLowerCase()}.github.io`
    ? 'provider-default' : (pending.pathPrefix === '/' ? 'domain-root' : 'domain-subpath');
  await writeRegisteredSiteConfiguration(siteRoot, {
    siteId, canonicalBaseUrl: pending.canonicalBaseUrl,
    pathPrefix: pending.pathPrefix, topology
  });
  const cnamePath = path.join(siteRoot, 'CNAME');
  if (pending.cname == null) await rm(cnamePath, { force: true });
  else await writeFile(cnamePath, `${pending.cname}\n`, { encoding: 'utf8' });
  await run(siteRoot, ['add', '-A', '--', 'site.config.yml', 'CNAME'], spawnProcess);
  const unchanged = await run(siteRoot, ['diff', '--cached', '--quiet', '--exit-code'], spawnProcess, [0, 1]);
  if (unchanged.code === 1) {
    await run(siteRoot, ['commit', '-m', `chore(gala): switch topology to ${topology}`], spawnProcess);
  }
  await run(siteRoot, ['push', 'origin', 'HEAD'], spawnProcess);
  const { output: commitSha } = await run(siteRoot, ['rev-parse', 'HEAD'], spawnProcess);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Git returned an invalid topology commit SHA');
  await provisionPages({
    owner, repository, accessToken: github.accessToken, commitSha, customDomain: pending.cname
  });
  const committed = await commit({
    apiBaseUrl: gala.apiBaseUrl, accessToken: gala.accessToken,
    siteId, changeId: pending.changeId
  });
  return Object.freeze({ ...committed, commitSha });
}
