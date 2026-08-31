import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { preview, refreshBuildSettings } from '../src/commands/preview.js';

const SITE_ID = '01M0T5Z4FBK60HTS7FH8JK06QK';

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
   * writer's first preview died with a raw Node module-resolution stack - the least actionable
   * failure in the CLI. They should not need to know npm is involved at all.
   */
  const { calls, spawnProcess } = runner();
  const output = terminal();
  await preview({ terminal: output, options, cwd: root, spawnProcess, regenerate: nothingToCheck });

  assert.equal(calls[0].command, 'npm');
  assert.deepEqual(calls[0].args, ['install', '--no-audit', '--no-fund']);
  assert.ok(output.said('step').some((m) => /first time only/.test(m)), JSON.stringify(output.lines));
  // Eleventy is run from the publication's own copy, so the preview matches what will be published.
  assert.match(calls[2].args[0], /node_modules\/@11ty\/eleventy\/cmd\.cjs$/);
});

test('does not reinstall when the tooling is already there and rebuilds managed reader assets', async () => {
  await eleventyPresent();
  const { calls, spawnProcess } = runner();
  const output = terminal();
  await preview({ terminal: output, options, cwd: root, spawnProcess, regenerate: nothingToCheck });

  assert.deepEqual(calls.filter(({ command }) => command === 'npm').map(({ args }) => args), [
    ['run', 'build:reader']
  ]);
  assert.ok(!output.said('step').some((m) => /first time only/.test(m)));
});

test('builds reader assets before Eleventy starts', async () => {
  await eleventyPresent();
  const { calls, spawnProcess } = runner();

  await preview({ terminal: terminal(), options, cwd: root, spawnProcess, regenerate: nothingToCheck });

  assert.deepEqual(calls.map(({ command, args }) => [command, ...args]), [
    ['npm', 'run', 'build:reader'],
    [process.execPath, path.join(root, 'node_modules', '@11ty', 'eleventy', 'cmd.cjs'), '--serve', '--watch']
  ]);
});

test('validates through the read-only preview manifest contract', async () => {
  await eleventyPresent();
  let received;
  const regenerate = async (options) => {
    received = options;
    return { results: [] };
  };
  const { spawnProcess } = runner();

  await preview({ terminal: terminal(), options, cwd: root, spawnProcess, regenerate });

  assert.equal(received.preview, true);
});

test('a registered preview refreshes platform settings before starting Eleventy', async () => {
  await eleventyPresent();
  await writeFile(path.join(root, 'site.config.yml'), `site:\n  id: ${SITE_ID}\nhosting:\n  canonicalBaseUrl: https://writer.github.io\n  pathPrefix: /notes\n`);
  const events = [];
  const { spawnProcess } = runner();

  await preview({
    terminal: terminal(), options, cwd: root, spawnProcess, regenerate: nothingToCheck,
    refreshSettings: async ({ siteId }) => { events.push(siteId); }
  });

  assert.deepEqual(events, [SITE_ID]);
});

test('writes only a validated live pagination policy into the preview build artifact', async () => {
  await refreshBuildSettings({
    terminal: terminal(), options, root, siteId: SITE_ID,
    resolveAccount: async () => 'writer',
    authenticate: async () => ({
      gala: { apiBaseUrl: 'https://api.example.com', accessToken: 'token' }
    }),
    createApi: () => ({
      json: async (url) => {
        assert.equal(url, `/v1/sites/${SITE_ID}/pagination/policy`);
        return { minimumPageSize: 12, maximumPageSize: 100, defaultPageSize: 24 };
      }
    }),
    now: () => new Date('2026-08-30T22:00:00Z')
  });

  assert.deepEqual(JSON.parse(await readFile(
    path.join(root, '.gala', 'build', 'build-settings.json'), 'utf8'
  )), {
    schemaVersion: 1,
    generatedAt: '2026-08-30T22:00:00.000Z',
    paginationPolicy: { minimumPageSize: 12, maximumPageSize: 100, defaultPageSize: 24 }
  });

  await assert.rejects(() => refreshBuildSettings({
    terminal: terminal(), options, root, siteId: SITE_ID,
    resolveAccount: async () => 'writer',
    authenticate: async () => ({
      gala: { apiBaseUrl: 'https://api.example.com', accessToken: 'token' }
    }),
    createApi: () => ({ json: async () => ({
      minimumPageSize: 30, maximumPageSize: 20, defaultPageSize: 24
    }) })
  }), /unusable pagination policy/);
});

test('a failed install reports npm’s own words rather than a module-resolution stack', async () => {
  const { spawnProcess } = runner({ installs: false });
  await assert.rejects(
    preview({ terminal: terminal(), options, cwd: root, spawnProcess, regenerate: nothingToCheck }),
    /could not install the preview dependencies/);
});

test('a failed build explains where its exact cause was printed and what to do next', async () => {
  await eleventyPresent();
  let call = 0;
  const spawnProcess = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', call++ === 0 ? 0 : 1, null));
    return child;
  };

  await assert.rejects(
    preview({ terminal: terminal(), options, cwd: root, spawnProcess, regenerate: nothingToCheck }),
    /preview build failed with exit code 1.*Review the build output above.*run preview again/
  );
});

test('a failed reader-asset build reports the captured build cause', async () => {
  await eleventyPresent();
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stderr.emit('data', 'stylesheet compilation failed');
      child.emit('exit', 1, null);
    });
    return child;
  };

  let failure;
  await assert.rejects(
    preview({ terminal: terminal(), options, cwd: root, spawnProcess, regenerate: nothingToCheck }),
    (error) => {
      failure = error;
      return /could not prepare the publication styles and reader tools/.test(error.message);
    }
  );
  assert.equal(failure.detail, 'stylesheet compilation failed');
});

test('stopping the preview with Ctrl-C is not a failure', async () => {
  await eleventyPresent();
  let call = 0;
  const spawnProcess = () => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (call++ === 0) child.emit('exit', 0, null);
      else child.emit('exit', null, 'SIGINT');
    });
    return child;
  };
  await preview({ terminal: terminal(), options, cwd: root, spawnProcess, regenerate: nothingToCheck });
});
