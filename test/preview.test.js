import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { preview } from '../src/commands/preview.js';

const options = { value: (name) => (name === 'root' ? root : undefined), on: () => false, positional: [] };
let root;

/** Content validation has its own tests; these are about what preview does around it. */
const nothingToCheck = async () => ({ results: [] });

function terminal() {
  const lines = [];
  const record = (kind) => (message) => lines.push([kind, message]);
  return {
    lines,
    said: (kind) => lines.filter(([k]) => k === kind).map(([, m]) => m),
    step: record('step'), done: record('done'), note: record('note'),
    fail: record('fail'), result: record('result'), blank: () => {}
  };
}

function runner({ installs = true } = {}) {
  const calls = [];
  const spawnProcess = (command, args, spawnOptions) => {
    calls.push({ command, args, spawnOptions });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(async () => {
      if (command === 'npm' && installs) await eleventyPresent();
      child.emit('exit', command === 'npm' && !installs ? 1 : 0, null);
    });
    return child;
  };
  return { calls, spawnProcess };
}

async function eleventyPresent() {
  const directory = path.join(root, 'node_modules', '@11ty', 'eleventy');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'cmd.cjs'), '');
}

test.beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gala-preview-'));
});

test('installs the publication tooling the first time, and says why it is waiting', async () => {
  /*
   * A freshly cloned publication has no node_modules. v0 spawned eleventy from it regardless, so a
   * writer's first preview died with a raw Node module-resolution stack — the least actionable
   * failure in the CLI. They should not need to know npm is involved at all.
   */
  const { calls, spawnProcess } = runner();
  const output = terminal();
  await preview({ terminal: output, options, cwd: root, spawnProcess, regenerate: nothingToCheck });

  assert.equal(calls[0].command, 'npm');
  assert.deepEqual(calls[0].args, ['install', '--no-audit', '--no-fund']);
  assert.ok(output.said('step').some((m) => /first time only/.test(m)), JSON.stringify(output.lines));
  // Eleventy is run from the publication's own copy, so the preview matches what will be published.
  assert.match(calls[1].args[0], /node_modules\/@11ty\/eleventy\/cmd\.cjs$/);
});

test('does not reinstall when the tooling is already there', async () => {
  await eleventyPresent();
  const { calls, spawnProcess } = runner();
  const output = terminal();
  await preview({ terminal: output, options, cwd: root, spawnProcess, regenerate: nothingToCheck });

  assert.ok(!calls.some(({ command }) => command === 'npm'), 'no install on a warm publication');
  assert.ok(!output.said('step').some((m) => /first time only/.test(m)));
});

test('a failed install reports npm’s own words rather than a module-resolution stack', async () => {
  const { spawnProcess } = runner({ installs: false });
  await assert.rejects(
    preview({ terminal: terminal(), options, cwd: root, spawnProcess, regenerate: nothingToCheck }),
    /Installing the preview tooling failed/);
});

test('stopping the preview with Ctrl-C is not a failure', async () => {
  await eleventyPresent();
  const spawnProcess = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', null, 'SIGINT'));
    return child;
  };
  await preview({ terminal: terminal(), options, cwd: root, spawnProcess, regenerate: nothingToCheck });
});
