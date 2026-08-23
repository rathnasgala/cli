import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { x as extractTar } from 'tar';

const PACKAGE = '@rathnasgala/theme';
const REGISTRY = 'https://registry.npmjs.org';
const PROTECTED = ['.git/', 'content/', 'custom.css', 'site.config.yml'];

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
      throw new Error(`${managed} has local changes; restore it with gala doctor before upgrading`);
    }
  }
}

async function replaceFile(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.gala-upgrade-${process.pid}`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

async function applyRelease(root, payload, installed, available) {
  const configFile = path.join(root, 'site.config.yml');
  const config = await readFile(configFile, 'utf8');
  const updated = config.replace(
    /(themePackage:\s*\n(?:\s+.*\n)*?\s+version:\s*)[^\s#]+/,
    `$1${available.themePackage.version}`,
  );
  if (updated === config) throw new Error('site.config.yml has no framework.themePackage.version');
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
    for (const managed of previousFiles) {
      if (available.files[managed] == null) await rm(path.join(root, managed));
    }
    for (const managed of Object.keys(available.files)) {
      const artifact = available.artifactSources?.[managed] ?? managed;
      await replaceFile(path.join(root, managed), await readFile(path.join(payload, artifact)));
    }
    await replaceFile(configFile, updated);
  } catch (error) {
    for (const managed of Object.keys(available.files)) {
      if (installed.files[managed] == null) await rm(path.join(root, managed), { force: true });
    }
    for (const managed of previousFiles) {
      await replaceFile(path.join(root, managed), await readFile(path.join(backup, managed)));
    }
    await replaceFile(configFile, await readFile(path.join(backup, 'site.config.yml')));
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
  terminal.result(`Theme ${installed.themePackage.version} → ${release.version} (${channel})`);
  if (installed.themePackage.version === release.version) {
    terminal.note('Already current.');
    return { changed: false, version: release.version };
  }
  if (!options.on('yes')) {
    const answer = await terminal.ask('Apply this managed theme upgrade? [y/N]', { fallback: 'no' });
    if (!/^y(?:es)?$/i.test(answer)) {
      terminal.note('Nothing changed.');
      return { changed: false, version: release.version };
    }
  }
  await assertNoManagedDrift(root, installed);
  const unpacked = await unpackRelease(release, fetchImpl);
  try {
    const available = await readManifest(path.join(unpacked.payload, '.gala', 'managed-files.json'));
    if (available.themePackage.version !== release.version) {
      throw new Error('Theme package version does not match its managed manifest');
    }
    await verifyPayload(unpacked.payload, available);
    await applyRelease(root, unpacked.payload, installed, available);
  } finally {
    await rm(unpacked.temporary, { recursive: true, force: true });
  }
  terminal.done(`Upgraded managed theme to ${release.version}`);
  terminal.note('Run gala preview, then gala publish when the result is approved.');
  return { changed: true, version: release.version };
}
