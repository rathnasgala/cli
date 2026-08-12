import { spawn } from 'node:child_process';
import path from 'node:path';

import { regenerateBuildManifest } from './validate-command.js';

const BUILD_WARNING_DELAY_MS = (5 * 60 * 1000) + 1;
const INITIAL_BUILD_COMPLETE = /\bWrote \d+ files?\b/;

export async function previewSite({
  root,
  today,
  spawnProcess = spawn,
  schedule = setTimeout,
  cancel = clearTimeout,
  output = process.stdout,
  warningOutput = process.stderr
}) {
  const siteRoot = path.resolve(root);
  const { results: validation } = await regenerateBuildManifest({ root: siteRoot, today });
  const failures = validation.filter(({ errors }) => errors.length > 0);
  if (failures.length > 0) {
    throw new Error(`Preview refused: ${failures.length} post variant(s) failed validation`);
  }

  const cli = path.join(siteRoot, 'node_modules', '@11ty', 'eleventy', 'cmd.cjs');
  const child = spawnProcess(process.execPath, [cli, '--serve', '--watch'], {
    cwd: siteRoot,
    env: { ...process.env, GALA_EVALUATION_DATE: today },
    shell: false,
    stdio: ['inherit', 'pipe', 'pipe']
  });

  return new Promise((resolve, reject) => {
    let initialOutput = '';
    let warningTimer = schedule(() => {
      warningOutput.write('warning\tbuild-duration-5m\n');
      warningTimer = undefined;
    }, BUILD_WARNING_DELAY_MS);
    const stopTimer = () => {
      if (warningTimer !== undefined) cancel(warningTimer);
      warningTimer = undefined;
    };
    child.stdout?.on('data', (chunk) => {
      output.write(chunk);
      initialOutput = `${initialOutput}${chunk}`.slice(-256);
      if (INITIAL_BUILD_COMPLETE.test(initialOutput)) stopTimer();
    });
    child.stderr?.on('data', (chunk) => warningOutput.write(chunk));
    child.once('error', (error) => {
      stopTimer();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      stopTimer();
      if (signal) reject(new Error(`Preview terminated by signal ${signal}`));
      else if (code !== 0) reject(new Error(`Preview exited with code ${code}`));
      else resolve();
    });
  });
}
