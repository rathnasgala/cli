import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { switchTopology } from '../src/topology-command.js';

const SITE = '01K00000000000000000000010';
const CHANGE = '01K00000000000000000000020';
const SHA = 'a'.repeat(40);

test('converges config and CNAME before Pages proof and API commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-topology-'));
  await writeFile(path.join(root, 'site.config.yml'), `schemaVersion: 1\nsite:\n  id: ${SITE}\nhosting:\n  provider: github-pages\n  topology: provider-default\n  canonicalBaseUrl: https://owner.github.io\n  pathPrefix: /repo\n`);
  const events = [];
  const commands = [];
  const spawnProcess = (_command, args) => {
    commands.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    queueMicrotask(() => {
      if (args[2] === 'diff') child.emit('exit', 1, null);
      else {
        if (args[2] === 'rev-parse') child.stdout.end(`${SHA}\n`);
        child.emit('exit', 0, null);
      }
    });
    return child;
  };

  const result = await switchTopology({
    root, owner: 'owner', repository: 'repo',
    canonicalBaseUrl: 'https://blog.example.com', pathPrefix: '/notes',
    readGala: async () => ({ apiBaseUrl: 'https://api.gala67.com', accessToken: 'gala' }),
    readGithub: async () => ({ accessToken: 'github' }),
    prepare: async () => ({
      changeId: CHANGE, canonicalBaseUrl: 'https://blog.example.com',
      pathPrefix: '/notes', cname: 'blog.example.com'
    }),
    provisionPages: async () => { events.push(`pages:${await readFile(path.join(root, 'CNAME'), 'utf8')}`); },
    commit: async () => { events.push('commit'); return { changeId: CHANGE, state: 'COMMITTED' }; },
    spawnProcess
  });

  assert.equal(result.commitSha, SHA);
  assert.deepEqual(events, ['pages:blog.example.com\n', 'commit']);
  assert.match(await readFile(path.join(root, 'site.config.yml'), 'utf8'), /topology: domain-subpath/);
  assert.ok(commands.some((args) => args.includes('commit')));
});
