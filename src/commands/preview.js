import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

import { checkContent } from '../content.js';
import { readPublication } from '../publication.js';

/**
 * Builds the site and serves it locally.
 *
 * Eleventy is run from the publication's own `node_modules`, so the preview uses the exact
 * framework version the repository is pinned to — the same one the publish workflow will use. A
 * preview that agrees with the local machine but not with production is worse than no preview.
 *
 * That pin is also why this installs dependencies when they are missing. A freshly cloned
 * publication has no `node_modules`, and v0 spawned eleventy from it regardless: the writer's first
 * preview died with a raw Node module-resolution stack, which says nothing about what to do. They
 * should not need to know npm is involved at all.
 */
export async function preview({
  terminal, options, cwd = process.cwd(), spawnProcess = spawn, regenerate
}) {
  const root = path.resolve(options.value('root') ?? cwd);
  const today = options.value('today');

  terminal.step('Checking content');
  await checkContent({ terminal, root, today, ...(regenerate == null ? {} : { regenerate }) });
  terminal.done('Content is valid');

  const eleventy = path.join(root, 'node_modules', '@11ty', 'eleventy', 'cmd.cjs');
  if (!await exists(eleventy)) {
    terminal.step('Installing what this publication needs — first time only');
    await install(root, spawnProcess);
    if (!await exists(eleventy)) {
      throw new Error('The preview tooling is still missing after installing. Check package.json.');
    }
    terminal.done('Installed');
  }

  const publication = await readPublication(root);
  terminal.step('Starting the preview — stop it with Ctrl-C');
  if (publication != null) terminal.note(`this is ${publication.name ?? 'your publication'} as it will look`);
  terminal.blank();

  const child = spawnProcess(process.execPath, [eleventy, '--serve', '--watch'], {
    cwd: root,
    env: { ...process.env, ...(today == null ? {} : { GALA_EVALUATION_DATE: today }) },
    shell: false,
    stdio: 'inherit'
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      // Ctrl-C is how a writer stops a preview; it is not a failure to report.
      if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 0 || code === 130) resolve();
      else if (signal) reject(new Error(`Preview stopped by ${signal}`));
      else reject(new Error(`Preview exited with ${code}`));
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
      const failure = new Error('Installing the preview tooling failed');
      failure.detail = said.trim();
      reject(failure);
    });
  });
}
