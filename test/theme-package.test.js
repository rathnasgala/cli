import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as tar from 'tar';
import { fetchVerifiedThemePackage } from '../src/theme-package.js';

async function archive({ outside = false, symbolicLink = false, hardLink = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-theme-fixture-'));
  const packageRoot = path.join(root, 'package', 'payload');
  await mkdir(path.join(packageRoot, '.gala'), { recursive: true });
  await mkdir(path.join(packageRoot, '.gala', 'artifact-files'), { recursive: true });
  await mkdir(path.join(packageRoot, 'assets'), { recursive: true });
  await writeFile(path.join(packageRoot, 'assets', 'theme.css'), 'body{}');
  const hash = createHash('sha256').update('body{}').digest('hex');
  const gitignoreHash = createHash('sha256').update('_site/\n').digest('hex');
  await writeFile(path.join(packageRoot, '.gala', 'artifact-files', 'gitignore'), '_site/\n');
  await writeFile(path.join(packageRoot, '.gala', 'managed-files.json'), JSON.stringify({
    files: { 'assets/theme.css': hash, '.gitignore': gitignoreHash },
    artifactSources: { '.gitignore': '.gala/artifact-files/gitignore' },
    themePackage: { name: '@rathnasgala/theme', version: '0.0.1' }
  }));
  if (outside) await writeFile(path.join(root, 'evil.txt'), 'evil');
  if (symbolicLink) await symlink('../assets/theme.css', path.join(packageRoot, 'linked.css'));
  if (hardLink) await link(path.join(packageRoot, 'assets', 'theme.css'), path.join(packageRoot, 'hard-linked.css'));
  const stream = tar.c({ cwd: root, gzip: true }, outside ? ['package', 'evil.txt'] : ['package']);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function oversizedArchive({ files, bytesPerFile }) {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-theme-large-'));
  const packageRoot = path.join(root, 'package', 'payload');
  await mkdir(packageRoot, { recursive: true });
  const names = [];
  for (let index = 0; index < files; index += 1) {
    const name = `file-${index}`;
    names.push(`package/payload/${name}`);
    await writeFile(path.join(packageRoot, name), Buffer.alloc(bytesPerFile));
  }
  const stream = tar.c({ cwd: root, gzip: true }, names);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function responses(bytes, { integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}` } = {}) {
  return async (url) => url.includes('registry.npmjs.org')
    ? new Response(JSON.stringify({
      name: '@rathnasgala/theme', version: '0.0.1',
      dist: { tarball: 'https://registry.example/theme.tgz', integrity }
    }), { headers: { 'content-type': 'application/json' } })
    : new Response(bytes);
}

test('verifies registry SRI and every manifest hash before returning an extracted package', async () => {
  const bytes = await archive();
  const result = await fetchVerifiedThemePackage({
    name: '@rathnasgala/theme', version: '0.0.1', fetchImpl: responses(bytes)
  });
  assert.equal(result.manifest.themePackage.version, '0.0.1');
  assert.equal(await readFile(path.join(result.staging, '.gitignore'), 'utf8'), '_site/\n');
});

test('fails closed when registry integrity is absent or does not match', async () => {
  const bytes = await archive();
  await assert.rejects(
    fetchVerifiedThemePackage({
      name: '@rathnasgala/theme', version: '0.0.1', fetchImpl: responses(bytes, { integrity: null })
    }),
    /no integrity/
  );
  await assert.rejects(
    fetchVerifiedThemePackage({
      name: '@rathnasgala/theme', version: '0.0.1',
      fetchImpl: responses(bytes, { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` })
    }),
    /integrity verification failed/
  );
});

test('rejects archive entries outside package prefix', async () => {
  const bytes = await archive({ outside: true });
  await assert.rejects(
    fetchVerifiedThemePackage({
      name: '@rathnasgala/theme', version: '0.0.1', fetchImpl: responses(bytes)
    }),
    /outside package/
  );
});

test('rejects symbolic links', async () => {
  const bytes = await archive({ symbolicLink: true });
  await assert.rejects(
    fetchVerifiedThemePackage({
      name: '@rathnasgala/theme', version: '0.0.1', fetchImpl: responses(bytes)
    }),
    /links are forbidden/
  );
});

test('rejects hardlinks', async () => {
  const bytes = await archive({ hardLink: true });
  await assert.rejects(
    fetchVerifiedThemePackage({
      name: '@rathnasgala/theme', version: '0.0.1', fetchImpl: responses(bytes)
    }),
    /links are forbidden/
  );
});

test('rejects an oversized individual entry before extraction', async () => {
  const bytes = await oversizedArchive({ files: 1, bytesPerFile: (10 * 1024 * 1024) + 1 });
  await assert.rejects(fetchVerifiedThemePackage({
    name: '@rathnasgala/theme', version: '0.0.1', fetchImpl: responses(bytes)
  }), /extraction limits/);
});

test('rejects excessive total expansion before extraction', async () => {
  const bytes = await oversizedArchive({ files: 6, bytesPerFile: 9 * 1024 * 1024 });
  await assert.rejects(fetchVerifiedThemePackage({
    name: '@rathnasgala/theme', version: '0.0.1', fetchImpl: responses(bytes)
  }), /extraction limits/);
});

test('rejects excessive archive entry count before extraction', async () => {
  const bytes = await oversizedArchive({ files: 2_049, bytesPerFile: 0 });
  await assert.rejects(fetchVerifiedThemePackage({
    name: '@rathnasgala/theme', version: '0.0.1', fetchImpl: responses(bytes)
  }), /extraction limits/);
});

test('rejects transmitted archives over the compressed limit before reading the body', async () => {
  const fetchImpl = async (url) => url.includes('registry.npmjs.org')
    ? new Response(JSON.stringify({
      name: '@rathnasgala/theme', version: '0.0.1',
      dist: { tarball: 'https://registry.example/theme.tgz', integrity: 'sha512-AA==' }
    }))
    : new Response(Buffer.from('tiny'), { headers: { 'content-length': String((10 * 1024 * 1024) + 1) } });
  await assert.rejects(fetchVerifiedThemePackage({
    name: '@rathnasgala/theme', version: '0.0.1', fetchImpl
  }), /compressed-size limit/);
});
