import { spawn } from 'node:child_process';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { galaApi } from '../api/gala.js';
import { accountForCommand } from '../auth/checkout-profile.js';
import { authenticatedProfile } from '../auth/profiles.js';
import { checkContent } from '../content.js';
import { readPublication } from '../publication.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * Builds the site and serves it locally.
 *
 * Eleventy is run from the publication's own `node_modules`, so the preview uses the exact
 * framework version the repository is pinned to - the same one the publish workflow will use. A
 * preview that agrees with the local machine but not with production is worse than no preview.
 *
 * That pin is also why this installs dependencies when they are missing. A freshly cloned
 * publication has no `node_modules`, and v0 spawned eleventy from it regardless: the writer's first
 * preview died with a raw Node module-resolution stack, which says nothing about what to do. They
 * should not need to know npm is involved at all.
 */
export async function preview({
  terminal, options, cwd = process.cwd(), spawnProcess = spawn, regenerate,
  refreshSettings = refreshBuildSettings
}) {
  const root = path.resolve(options.value('root') ?? cwd);
  const today = options.value('today');
  const publication = await readPublication(root);

  terminal.step('Checking content');
  await checkContent({
    terminal, root, today, preview: true, ...(regenerate == null ? {} : { regenerate })
  });
  terminal.done('Content is valid');

  if (ULID.test(publication?.siteId ?? '')) {
    terminal.step('Reading Gala pagination policy');
    await refreshSettings({ terminal, options, root, siteId: publication.siteId });
    terminal.done('Pagination policy is current');
  }

  const eleventy = path.join(root, 'node_modules', '@11ty', 'eleventy', 'cmd.cjs');
  if (!await exists(eleventy)) {
    terminal.step('Installing what this publication needs - first time only');
    await install(root, spawnProcess);
    if (!await exists(eleventy)) {
      throw new Error('Gala installed the publication dependencies, but the preview tool is still missing. Restore the managed package.json and package-lock.json files, then run preview again.');
    }
    terminal.done('Installed');
  }

  terminal.step('Preparing the preview');
  await buildReader(root, spawnProcess);
  terminal.done('Preview is ready');

  terminal.step('Starting the preview - stop it with Ctrl-C');
  if (publication != null) terminal.note(`this is ${publication.name ?? 'your publication'} as it will look`);
  terminal.blank();

  const child = spawnProcess(process.execPath, [eleventy, '--serve', '--watch'], {
    cwd: root,
    env: { ...process.env, ...(today == null ? {} : { GALA_EVALUATION_DATE: today }) },
    shell: false,
    stdio: 'inherit'
  });

  return new Promise((resolve, reject) => {
    child.once('error', (error) => {
      reject(new Error(`The preview could not start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      // Ctrl-C is how a writer stops a preview; it is not a failure to report.
      if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 0 || code === 130) resolve();
      else if (signal) {
        reject(new Error(`The preview process was stopped by ${signal}. Review the build output above, correct the reported problem, and run preview again.`));
      } else {
        reject(new Error(`The preview build failed with exit code ${code}. Review the build output above, correct the reported problem, and run preview again.`));
      }
    });
  });
}

export async function refreshBuildSettings({
  terminal,
  options,
  root,
  siteId,
  resolveAccount = accountForCommand,
  authenticate = authenticatedProfile,
  createApi = galaApi,
  now = () => new Date()
}) {
  const account = await resolveAccount(options, root, { terminal });
  const credential = (await authenticate({ name: account, terminal })).gala;
  const resolution = await createApi({
    baseUrl: credential.apiBaseUrl,
    token: credential.accessToken
  }).json(`/v1/sites/${siteId}/pagination/policy`, { action: 'Pagination policy lookup' });
  const policy = resolution;
  if (policy == null || Array.isArray(policy) || typeof policy !== 'object'
      || !['minimumPageSize', 'maximumPageSize', 'defaultPageSize'].every(
        (field) => Number.isSafeInteger(policy[field])
      )
      || policy.minimumPageSize < 1 || policy.maximumPageSize > 100
      || policy.minimumPageSize > policy.defaultPageSize
      || policy.defaultPageSize > policy.maximumPageSize) {
    throw new Error('Gala returned an unusable pagination policy. The preview was not started.');
  }
  await atomicJson(path.join(root, '.gala', 'build', 'build-settings.json'), {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    paginationPolicy: {
      minimumPageSize: policy.minimumPageSize,
      maximumPageSize: policy.maximumPageSize,
      defaultPageSize: policy.defaultPageSize
    }
  });
}

async function atomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } catch (failure) {
    await rm(temporary, { force: true });
    throw failure;
  }
}

function buildReader(root, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('npm', ['run', 'build:reader'], {
      cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe']
    });
    let said = '';
    child.stdout?.on('data', (chunk) => { said += chunk; });
    child.stderr?.on('data', (chunk) => { said += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const failure = new Error('Gala could not prepare the publication styles and reader tools. The build output below contains the cause.');
      failure.detail = said.trim();
      reject(failure);
    });
  });
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Output is captured; it is npm's, not the writer's, unless something goes wrong. */
function install(root, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe']
    });
    let said = '';
    child.stdout?.on('data', (chunk) => { said += chunk; });
    child.stderr?.on('data', (chunk) => { said += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const failure = new Error('Gala could not install the preview dependencies. The package-manager output below contains the cause.');
      failure.detail = said.trim();
      reject(failure);
    });
  });
}
