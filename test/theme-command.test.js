import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parse } from 'yaml';

import { credentialEnvironment } from './credential-fixture.js';

const run = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const siteId = '01M0T5Z4FBK60HTS7FH8JK06QK';

test('themes are visible, integrity checked, staged locally, previewable, and reversible',
  { timeout: 15_000 }, async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'gala-theme-command-'));
    const home = await mkdtemp(path.join(tmpdir(), 'gala-theme-home-'));
    await mkdir(path.join(root, 'static', 'assets'), { recursive: true });
    const configuration = (frameworkVersion) => `framework:
  themePackage:
    name: "@rathnasgala/theme"
    version: ${frameworkVersion}
site:
  id: ${siteId}
  repository: writer/notes
hosting:
  canonicalBaseUrl: https://writer.github.io
  pathPrefix: /notes
performance:
  budgets:
    managedJavaScriptBytes: 94208
    managedCssBytes: 36864
    ordinaryHtmlBytes: 32768
`;
    await writeFile(path.join(root, 'site.config.yml'), configuration('2.0.32'));
    const css = ':root { --gala-color-accent: #123456; }\n';
    const cssBytes = Buffer.byteLength(css);
    const cssSha256 = createHash('sha256').update(css).digest('hex');
    let corruptPreview = false;
    let remoteFramework = '2.0.32';
    let additiveCatalog = false;
    const release = {
      themeId: 'awesome', version: '1.0.0', displayName: 'Awesome',
      description: 'Expressive editorial styling.', repositoryOwner: 'rathnasgala',
      repositoryName: 'theme-awesome', commitSha: 'a'.repeat(40),
      minimumFrameworkVersion: '2.0.32', maximumFrameworkVersionExclusive: '3.0.0',
      cssPath: 'theme.css', cssSha256, cssBytes, status: 'ACTIVE',
      registeredByUserId: '01K00000000000000000000020', registeredAt: '2026-09-02T12:00:00Z',
      retiredByUserId: null, retiredAt: null,
    };
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === `/v1/sites/${siteId}/appearance-theme`) {
        const compatible = remoteFramework !== '2.0.31';
        response.end(JSON.stringify({
          selected: null,
          frameworkVersion: remoteFramework,
          releases: compatible ? [release] : [],
          ...(additiveCatalog ? {
            updateRequiredReleases: compatible ? [] : [release],
            updateCheckUnavailable: false,
          } : {}),
        }));
        return;
      }
      if (request.method === 'GET'
          && request.url === `/v1/sites/${siteId}/appearance-theme/awesome/1.0.0/preview`) {
        response.end(JSON.stringify({
          themeId: 'awesome', version: '1.0.0', cssSha256, cssBytes,
          css: corruptPreview ? `${css}tampered` : css,
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not found' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => server.close());
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    const environment = await credentialEnvironment(home, {
      accessToken: 'test-token', apiBaseUrl: `http://127.0.0.1:${address.port}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    const invoke = (args) => run(process.execPath, [entry, ...args, '--account', 'test'], {
      cwd: root, env: environment,
    });

    const listed = await invoke(['theme', 'list']);
    assert.match(listed.stdout, /available\s+awesome 1\.0\.0 — Awesome/);
    const staged = await invoke(['theme', 'use', 'awesome']);
    assert.match(staged.stdout, /Staged Awesome 1\.0\.0/);
    assert.match(staged.stdout, /Nothing has been committed or sent to GitHub/);
    assert.equal(await readFile(path.join(root, 'static', 'assets', 'appearance-theme.css'), 'utf8'), css);
    const selected = parse(await readFile(path.join(root, 'site.config.yml'), 'utf8'));
    assert.deepEqual(selected.appearanceTheme, {
      id: 'awesome', version: '1.0.0', repository: 'rathnasgala/theme-awesome',
      commitSha: release.commitSha, cssSha256, cssBytes, baseManagedCssBytes: 36864,
    });
    assert.equal(selected.performance.budgets.managedCssBytes, 36864 + cssBytes);

    const status = await invoke(['theme', 'status']);
    assert.match(status.stdout, /awesome 1\.0\.0/);
    assert.match(status.stdout, /local selection differs from GitHub/);
    const restored = await invoke(['theme', 'use', 'built-in']);
    assert.match(restored.stdout, /Staged the built-in Gala appearance/);
    const restoredConfiguration = parse(await readFile(path.join(root, 'site.config.yml'), 'utf8'));
    assert.equal(restoredConfiguration.appearanceTheme, undefined);
    assert.equal(restoredConfiguration.performance.budgets.managedCssBytes, 36864);

    const priorTheme = `${configuration('2.0.32').replace(
      'managedCssBytes: 36864', 'managedCssBytes: 39936',
    )}appearanceTheme:
  id: old-theme
  version: 1.0.0
  repository: "rathnasgala/theme-old"
  commitSha: ${'c'.repeat(40)}
  cssSha256: ${'d'.repeat(64)}
  cssBytes: 2048
  baseManagedCssBytes: 36864
`;
    await writeFile(path.join(root, 'site.config.yml'), priorTheme);
    await invoke(['theme', 'use', 'awesome']);
    const switched = parse(await readFile(path.join(root, 'site.config.yml'), 'utf8'));
    assert.equal(switched.performance.budgets.managedCssBytes, 36864 + 1024 + cssBytes);
    assert.equal(switched.appearanceTheme.id, 'awesome');

    await writeFile(path.join(root, 'site.config.yml'), configuration('2.0.31'));
    const unavailable = await invoke(['theme', 'list']);
    assert.match(unavailable.stdout, /upgrade required\s+awesome 1\.0\.0/);
    await assert.rejects(invoke(['theme', 'use', 'awesome']), (failure) => {
      assert.match(failure.stderr, /requires Gala framework 2\.0\.32 or newer/);
      assert.match(failure.stderr, /upgrade --yes/);
      return true;
    });

    await writeFile(path.join(root, 'site.config.yml'), configuration('2.0.33'));
    remoteFramework = '2.0.31';
    additiveCatalog = true;
    await assert.rejects(invoke(['theme', 'use', 'awesome']), (failure) => {
      assert.match(failure.stderr, /local framework 2\.0\.33 supports Awesome/);
      assert.match(failure.stderr, /GitHub still has framework 2\.0\.31/);
      assert.match(failure.stderr, /publish.*wait for that build/);
      return true;
    });

    await writeFile(path.join(root, 'site.config.yml'), configuration('2.0.32'));
    remoteFramework = '2.0.32';
    const before = await readFile(path.join(root, 'site.config.yml'), 'utf8');
    corruptPreview = true;
    await assert.rejects(invoke(['theme', 'use', 'awesome']), /integrity verification/);
    assert.equal(await readFile(path.join(root, 'site.config.yml'), 'utf8'), before);
  });
