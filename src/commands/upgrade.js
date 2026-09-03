import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { x as extractTar } from 'tar';
import { parseDocument } from 'yaml';

import { cliCommand } from '../cli/invocation.js';

const PACKAGE = '@rathnasgala/theme';
const REGISTRY = 'https://registry.npmjs.org';
const PROTECTED = ['.git/', 'content/', 'custom.css', 'site.config.yml'];
const WORKFLOW = '.github/workflows/publish.yml';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const safeManagedPath = (value) => typeof value === 'string' && value !== ''
  && !path.isAbsolute(value) && !value.split('/').includes('..')
  && !PROTECTED.some((protectedPath) => value === protectedPath || value.startsWith(protectedPath));

async function exists(file) {
  try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function verifyIntegrity(bytes, integrity) {
  const [algorithm, expected] = String(integrity ?? '').split('-', 2);
  if (!['sha512', 'sha256'].includes(algorithm) || !expected) {
    throw new Error('The registry did not provide supported package integrity metadata');
  }
  const actual = createHash(algorithm).update(bytes).digest('base64');
  if (actual !== expected) throw new Error('The downloaded theme failed registry integrity verification');
}

async function registryRelease(channel, fetchImpl) {
  const response = await fetchImpl(`${REGISTRY}/${encodeURIComponent(PACKAGE)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Theme registry lookup failed with HTTP ${response.status}`);
  const metadata = await response.json();
  const version = metadata?.['dist-tags']?.[channel];
  const release = metadata?.versions?.[version];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '') || !release?.dist?.tarball) {
    throw new Error(`Theme channel ${channel} has no valid release`);
  }
  if (release.scripts && Object.keys(release.scripts).length > 0) {
    throw new Error('Theme release contains lifecycle scripts and was refused');
  }
  return { version, tarball: release.dist.tarball, integrity: release.dist.integrity };
}

async function unpackRelease(release, fetchImpl) {
  const response = await fetchImpl(release.tarball);
  if (!response.ok) throw new Error(`Theme download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(bytes, release.integrity);
  const temporary = await mkdtemp(path.join(tmpdir(), 'gala-theme-upgrade-'));
  const archive = path.join(temporary, 'theme.tgz');
  const extracted = path.join(temporary, 'unpacked');
  await mkdir(extracted);
  await writeFile(archive, bytes);
  await extractTar({ file: archive, cwd: extracted, strip: 1, strict: true });
  return { temporary, payload: path.join(extracted, 'payload') };
}

async function readManifest(file) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (manifest?.schemaVersion !== 1 || typeof manifest.files !== 'object') {
    throw new Error('Theme managed-file manifest is invalid');
  }
  for (const managed of Object.keys(manifest.files)) {
    if (!safeManagedPath(managed)) throw new Error(`Theme release contains protected path: ${managed}`);
  }
  return manifest;
}

async function verifyPayload(payload, manifest) {
  for (const [managed, expected] of Object.entries(manifest.files)) {
    const artifact = manifest.artifactSources?.[managed] ?? managed;
    if (!safeManagedPath(artifact)) throw new Error(`Theme artifact path is unsafe: ${artifact}`);
    const bytes = await readFile(path.join(payload, artifact));
    if (sha256(bytes) !== expected) throw new Error(`Theme payload hash mismatch: ${managed}`);
  }
}

async function assertNoManagedDrift(root, installed) {
  for (const [managed, expected] of Object.entries(installed.files)) {
    const file = path.join(root, managed);
    if (!await exists(file) || (await lstat(file)).isSymbolicLink() || sha256(await readFile(file)) !== expected) {
      throw new Error(`${managed} has local changes; restore it with ${cliCommand('doctor')} before upgrading`);
    }
  }
}

async function replaceFile(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.gala-upgrade-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

function withMandatoryWorkflowPermissions(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const permissions = lines
    .map((line, index) => line.trimEnd() === 'permissions:' ? index : -1)
    .filter((index) => index >= 0);
  if (permissions.length !== 1 || lines[permissions[0]] !== 'permissions:') {
    throw new Error('Publishing workflow permissions are unsupported; restore the Gala-generated workflow before upgrading');
  }
  const start = permissions[0];
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === ''
    || lines[end].trimStart().startsWith('#') || /^\s/.test(lines[end]))) end++;
  const entry = (name) => lines
    .map((line, index) => index > start && index < end
      && line.startsWith(`  ${name}:`) ? index : -1)
    .filter((index) => index >= 0);
  const contents = entry('contents');
  if (contents.length !== 1 || lines[contents[0]].trimEnd() !== '  contents: write') {
    throw new Error('Publishing workflow must grant contents: write before it can be upgraded');
  }
  const identity = entry('id-token');
  const attestations = entry('attestations');
  if (identity.length > 1 || attestations.length > 1) {
    throw new Error('Publishing workflow contains duplicate permission entries');
  }
  for (const index of [...identity, ...attestations].sort((left, right) => right - left)) {
    lines.splice(index, 1);
  }
  const insertAfter = lines.findIndex((line, index) => index > start
    && line.trimEnd() === '  contents: write');
  lines.splice(insertAfter + 1, 0, '  id-token: write', '  attestations: write');
  return lines.join(newline);
}

async function workflowMigration(root) {
  const target = path.join(root, WORKFLOW);
  if (!await exists(target)) return null;
  const previous = await readFile(target, 'utf8');
  const updated = withMandatoryWorkflowPermissions(previous);
  return updated === previous ? null : { target, previous, updated };
}

function withRequiredPerformanceBudgets(source, required) {
  const fields = ['managedJavaScriptBytes', 'managedCssBytes'];
  if (required == null || Array.isArray(required) || typeof required !== 'object'
      || !fields.every((field) => Number.isSafeInteger(required[field]) && required[field] > 0)) {
    throw new Error('Theme managed-file manifest has invalid required budgets');
  }
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error('site.config.yml is invalid');
  let changed = false;
  for (const field of fields) {
    const pathToBudget = ['performance', 'budgets', field];
    const current = document.getIn(pathToBudget);
    if (current != null && (!Number.isSafeInteger(current) || current <= 0)) {
      throw new Error(`site.config.yml performance.budgets.${field} must be a positive integer`);
    }
    if (current == null || current < required[field]) {
      document.setIn(pathToBudget, required[field]);
      changed = true;
    }
  }
  return changed ? document.toString() : source;
}

async function performanceBudgetMigration(root, required) {
  if (required == null) return null;
  const target = path.join(root, 'site.config.yml');
  const previous = await readFile(target, 'utf8');
  const updated = withRequiredPerformanceBudgets(previous, required);
  return updated === previous ? null : { target, updated };
}

async function applyRelease(root, payload, installed, available, workflow) {
  const configFile = path.join(root, 'site.config.yml');
  const manifestFile = path.join(root, '.gala', 'managed-files.json');
  const config = await readFile(configFile, 'utf8');
  const versioned = config.replace(
    /(themePackage:\s*\n(?:\s+.*\n)*?\s+version:\s*)[^\s#]+/,
    `$1${available.themePackage.version}`,
  );
  if (versioned === config) throw new Error('site.config.yml has no framework.themePackage.version');
  const updated = withRequiredPerformanceBudgets(versioned, available.requiredBudgets);
  const backup = await mkdtemp(path.join(tmpdir(), 'gala-theme-rollback-'));
  const previousFiles = Object.keys(installed.files);
  try {
    for (const managed of previousFiles) {
      const target = path.join(root, managed);
      const saved = path.join(backup, managed);
      await mkdir(path.dirname(saved), { recursive: true });
      await copyFile(target, saved);
    }
    await copyFile(configFile, path.join(backup, 'site.config.yml'));
    await copyFile(manifestFile, path.join(backup, 'managed-files.json'));
    for (const managed of previousFiles) {
      if (available.files[managed] == null) await rm(path.join(root, managed));
    }
    for (const managed of Object.keys(available.files)) {
      const artifact = available.artifactSources?.[managed] ?? managed;
      await replaceFile(path.join(root, managed), await readFile(path.join(payload, artifact)));
    }
    await replaceFile(configFile, updated);
    await replaceFile(manifestFile, `${JSON.stringify(available, null, 2)}\n`);
    if (workflow != null) await replaceFile(workflow.target, workflow.updated);
  } catch (error) {
    for (const managed of Object.keys(available.files)) {
      if (installed.files[managed] == null) await rm(path.join(root, managed), { force: true });
    }
    for (const managed of previousFiles) {
      await replaceFile(path.join(root, managed), await readFile(path.join(backup, managed)));
    }
    await replaceFile(configFile, await readFile(path.join(backup, 'site.config.yml')));
    await replaceFile(manifestFile, await readFile(path.join(backup, 'managed-files.json')));
    if (workflow != null) await replaceFile(workflow.target, workflow.previous);
    throw error;
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
}

export async function upgrade({ terminal, options, cwd = process.cwd(), fetchImpl = fetch }) {
  const root = path.resolve(options.value('root') ?? cwd);
  const channel = options.value('channel') ?? 'latest';
  if (!['latest', 'next'].includes(channel)) throw new Error('channel must be latest or next');
  const installed = await readManifest(path.join(root, '.gala', 'managed-files.json'));
  const release = await registryRelease(channel, fetchImpl);
  const workflow = await workflowMigration(root);
  const budgetMigration = await performanceBudgetMigration(root, installed.requiredBudgets);
  terminal.result(`Theme ${installed.themePackage.version} → ${release.version} (${channel})`);
  const themeChanged = installed.themePackage.version !== release.version;
  if (!themeChanged && workflow == null && budgetMigration == null) {
    terminal.note('Already current.');
    return { changed: false, version: release.version };
  }
  if (!options.on('yes')) {
    const answer = await terminal.ask('Apply this managed publication upgrade? [y/N]', { fallback: 'no' });
    if (!/^y(?:es)?$/i.test(answer)) {
      terminal.note('Nothing changed.');
      return { changed: false, version: release.version };
    }
  }
  if (themeChanged) {
    await assertNoManagedDrift(root, installed);
    const unpacked = await unpackRelease(release, fetchImpl);
    try {
      const available = await readManifest(path.join(unpacked.payload, '.gala', 'managed-files.json'));
      if (available.themePackage.version !== release.version) {
        throw new Error('Theme package version does not match its managed manifest');
      }
      await verifyPayload(unpacked.payload, available);
      await applyRelease(root, unpacked.payload, installed, available, workflow);
    } finally {
      await rm(unpacked.temporary, { recursive: true, force: true });
    }
    terminal.done(`Upgraded managed theme to ${release.version}`);
  } else {
    if (workflow != null) await replaceFile(workflow.target, workflow.updated);
    if (budgetMigration != null) await replaceFile(budgetMigration.target, budgetMigration.updated);
  }
  if (workflow != null) terminal.done('Updated publishing workflow permissions');
  if (budgetMigration != null) terminal.done('Updated performance budgets');
  terminal.note(`Run ${cliCommand('preview')}, then ${cliCommand('publish')} when the result is approved.`);
  return { changed: true, version: release.version };
}
