import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  galaCredentialPath,
  readGalaCredential,
  writeGalaCredential
} from '../src/gala-credential-store.js';

test('selects the operating-system application config directory', () => {
  assert.equal(
    galaCredentialPath({ platform: 'darwin', home: '/Users/author', environment: {} }),
    '/Users/author/Library/Application Support/Gala/credentials.json'
  );
  assert.equal(
    galaCredentialPath({ platform: 'linux', home: '/home/author', environment: {} }),
    '/home/author/.config/gala/credentials.json'
  );
  assert.equal(
    galaCredentialPath({ platform: 'linux', home: '/home/author', environment: { XDG_CONFIG_HOME: '/config' } }),
    '/config/gala/credentials.json'
  );
  assert.equal(
    galaCredentialPath({ platform: 'win32', home: 'ignored', environment: { APPDATA: 'C:\\Config' } }),
    path.join('C:\\Config', 'Gala', 'credentials.json')
  );
});

test('writes atomically with private permissions and reads a live credential', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gala-credential-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'config', 'credentials.json');
  const expiresAt = new Date('2026-09-12T00:00:00Z');

  await writeGalaCredential({
    accessToken: 'secret-gala-token',
    expiresAt,
    apiBaseUrl: 'https://api.gala67.com',
    target
  });

  assert.equal((await lstat(target)).mode & 0o777, 0o600);
  assert.equal((await lstat(path.dirname(target))).mode & 0o777, 0o700);
  assert.match(await readFile(target, 'utf8'), /secret-gala-token/);
  const credential = await readGalaCredential({ target, now: new Date('2026-08-12T00:00:00Z') });
  assert.equal(credential.accessToken, 'secret-gala-token');
  assert.equal(credential.expiresAt.toISOString(), expiresAt.toISOString());
});

test('rejects expired credentials and symlink targets', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gala-credential-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'credentials.json');
  await writeGalaCredential({
    accessToken: 'expired',
    expiresAt: new Date('2026-08-01T00:00:00Z'),
    apiBaseUrl: 'https://api.gala67.com',
    target
  });
  await assert.rejects(
    readGalaCredential({ target, now: new Date('2026-08-12T00:00:00Z') }),
    /run `gala auth` again/
  );

  const real = path.join(directory, 'real.json');
  await writeGalaCredential({
    accessToken: 'real', expiresAt: new Date('2026-09-01T00:00:00Z'),
    apiBaseUrl: 'https://api.gala67.com', target: real
  });
  const linked = path.join(directory, 'linked.json');
  await symlink(real, linked);
  await assert.rejects(
    writeGalaCredential({
      accessToken: 'replacement', expiresAt: new Date('2026-09-01T00:00:00Z'),
      apiBaseUrl: 'https://api.gala67.com', target: linked
    }),
    /must be a regular file/
  );
});

test('rejects missing credentials and unsafe API base URLs', async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gala-credential-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'credentials.json');

  await assert.rejects(readGalaCredential({ target }), /authentication is missing/);
  await assert.rejects(
    writeGalaCredential({
      accessToken: 'secret', expiresAt: new Date('2026-09-01T00:00:00Z'),
      apiBaseUrl: 'http://api.gala67.com', target
    }),
    /credential-free HTTPS/
  );
  await assert.rejects(
    writeGalaCredential({
      accessToken: 'secret', expiresAt: new Date('2026-09-01T00:00:00Z'),
      apiBaseUrl: 'https://user:password@api.gala67.com?leak=true', target
    }),
    /credential-free HTTPS/
  );
});
