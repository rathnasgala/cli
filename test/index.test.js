import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { parse } from 'yaml';

const execute = promisify(execFile);

test('help exits successfully before reading credentials or mutating a repository', async () => {
  for (const invocation of [['--help'], ['-h'], ['scaffold', '--help']]) {
    const { stdout, stderr } = await execute(
      process.execPath,
      [fileURLToPath(new URL('../src/index.js', import.meta.url)), ...invocation]
    );
    assert.match(stdout, /^Usage: gala /);
    assert.equal(stderr, '');
  }
});

test('configure updates existing site design without invoking scaffold integration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-cli-configure-'));
  const configPath = path.join(root, 'site.config.yml');
  await writeFile(configPath, `schemaVersion: 1
site:
  name: Existing Site
  defaultLanguage: en
  timezone: UTC
design:
  theme: editorial
  layout: article-first
  palette: default
sharing:
  targets: []
  socialProfiles: {}
`);

  const { stdout, stderr } = await execute(
    process.execPath,
    [
      fileURLToPath(new URL('../src/index.js', import.meta.url)),
      'configure',
      '--root', root,
      '--layout', 'portfolio',
      '--palette', 'ocean'
    ],
    { cwd: root }
  );

  const config = parse(await readFile(configPath, 'utf8'));
  assert.equal(stderr, '');
  assert.equal(config.design.layout, 'portfolio');
  assert.equal(config.design.palette, 'ocean');
  assert.match(stdout, /"layout": "portfolio"/);
});

test('every existing-site command reports repository limit warnings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-cli-limits-'));
  const bin = path.join(root, 'bin');
  await mkdir(path.join(root, 'content', 'posts'), { recursive: true });
  await mkdir(path.join(root, '.git'));
  await mkdir(bin);
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1
site:
  name: Existing Site
  defaultLanguage: en
  timezone: UTC
design:
  theme: editorial
  layout: article-first
  palette: default
sharing:
  targets: []
  socialProfiles: {}
`);
  const fakeGit = path.join(bin, 'git');
  await writeFile(fakeGit, '#!/bin/sh\nprintf "count: 1\\nsize: 512001\\nin-pack: 0\\nsize-pack: 0\\n"\n');
  await chmod(fakeGit, 0o700);

  const { stderr } = await execute(
    process.execPath,
    [
      fileURLToPath(new URL('../src/index.js', import.meta.url)),
      'configure',
      '--root', root,
      '--layout', 'article-first'
    ],
    { cwd: root, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }
  );

  assert.match(stderr, /warning\trepository-size-500mb/);
});
