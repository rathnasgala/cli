import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readPublicationState, PUBLICATION_STATE_PATH } from './publication-state.js';

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export async function diagnoseFramework(root) {
  const manifestPath = managedPath(root, '.gala/managed-files.json');
  let manifest;
  try {
    await assertSafeAncestors(root, manifestPath);
    await assertNotSymbolicLink(manifestPath, false);
    manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [{ path: '.gala/managed-files.json', status: 'missing-manifest' }];
    }
    throw new TypeError(`Invalid managed-file manifest: ${error.message}`);
  }

  return diagnoseAgainstManifest(root, manifest);
}

export async function diagnosePublicationState(root) {
  try {
    await readPublicationState(root);
    return { path: PUBLICATION_STATE_PATH.split(path.sep).join('/'), status: 'valid' };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { path: PUBLICATION_STATE_PATH.split(path.sep).join('/'), status: 'missing' };
    }
    return {
      path: PUBLICATION_STATE_PATH.split(path.sep).join('/'),
      status: 'invalid',
      detail: error.message
    };
  }
}

async function diagnoseAgainstManifest(root, manifest) {
  const findings = [];
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    if (relativePath === '.gala/managed-files.json') {
      throw new TypeError('Managed-file manifest cannot manage itself');
    }
    const file = managedPath(root, relativePath);
    try {
      await assertSafeAncestors(root, file);
      await assertNotSymbolicLink(file, false);
      const actualHash = await sha256(file);
      findings.push({
        path: relativePath,
        status: actualHash === expectedHash ? 'intact' : 'modified'
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      findings.push({ path: relativePath, status: 'missing' });
    }
  }
  return findings;
}

function parseManifest(source) {
  const manifest = JSON.parse(source);
  if (manifest.schemaVersion !== 1 || manifest.files == null || Array.isArray(manifest.files)) {
    throw new TypeError('Unsupported managed-file manifest schema');
  }
  return manifest;
}

function managedPath(root, relativePath) {
  if (path.isAbsolute(relativePath)) throw new TypeError(`Managed path must be relative: ${relativePath}`);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split('/'));
  const relation = path.relative(resolvedRoot, resolved);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new TypeError(`Managed path escapes the site root: ${relativePath}`);
  }
  const [firstSegment] = relation.split(path.sep);
  const protectedFile = new Set([
    '.engagement-snapshot.json',
    '.gala/publication-state.yml',
    '.github/workflows/publish.yml',
    'CNAME',
    'custom.css',
    'site.config.yml'
  ]).has(relation);
  if (
    protectedFile
    || firstSegment === '.git'
    || firstSegment === 'content'
    || relation === '.env'
    || (relation.startsWith('.env.') && relation !== '.env.example')
  ) {
    throw new TypeError(`Author-owned path cannot be managed: ${relativePath}`);
  }
  return resolved;
}

async function assertNotSymbolicLink(file, allowMissing) {
  try {
    const metadata = await lstat(file);
    if (metadata.isSymbolicLink()) throw new TypeError(`Refusing symbolic link: ${file}`);
    return metadata;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSafeAncestors(root, file) {
  const resolvedRoot = path.resolve(root);
  const segments = path.relative(resolvedRoot, path.dirname(file)).split(path.sep).filter(Boolean);
  let cursor = resolvedRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const metadata = await assertNotSymbolicLink(cursor, true);
    if (metadata == null) return;
    if (!metadata.isDirectory()) throw new TypeError(`Managed path ancestor is not a directory: ${cursor}`);
  }
}

export async function repairFramework(root, sourceRoot) {
  const manifestPath = path.resolve(root, '.gala', 'managed-files.json');
  const sourceManifestPath = path.resolve(sourceRoot, '.gala', 'managed-files.json');
  await assertSafeAncestors(sourceRoot, sourceManifestPath);
  const sourceManifestMetadata = await assertNotSymbolicLink(sourceManifestPath, false);
  if (!sourceManifestMetadata.isFile()) throw new TypeError('Trusted manifest must be a regular file');
  const sourceManifest = await readFile(sourceManifestPath);
  const manifest = parseManifest(sourceManifest.toString('utf8'));
  await assertSafeAncestors(root, manifestPath);
  await assertNotSymbolicLink(manifestPath, true);

  const findings = await diagnoseAgainstManifest(root, manifest);
  const repairTargets = findings.filter(({ status }) => status === 'missing' || status === 'modified');
  const validated = [];

  // Validate the entire repair set before replacing the first target.
  for (const finding of repairTargets) {
    const expectedHash = manifest.files[finding.path];
    const source = managedPath(sourceRoot, finding.path);
    const target = managedPath(root, finding.path);
    await assertSafeAncestors(sourceRoot, source);
    await assertSafeAncestors(root, target);
    const sourceMetadata = await assertNotSymbolicLink(source, false);
    if (!sourceMetadata.isFile()) throw new TypeError(`Repair source is not a file: ${finding.path}`);
    const targetMetadata = await assertNotSymbolicLink(target, true);
    if (await sha256(source) !== expectedHash) {
      throw new TypeError(`Repair source hash mismatch: ${finding.path}`);
    }
    validated.push({ ...finding, source, target, targetExists: targetMetadata != null });
  }

  const repaired = [];
  for (const item of validated) {
    await mkdir(path.dirname(item.target), { recursive: true });
    const temporary = `${item.target}.gala-repair-${process.pid}`;
    const backup = `${item.target}.gala-backup-${process.pid}`;
    let backedUp = false;
    try {
      await writeFile(temporary, await readFile(item.source), { flag: 'wx' });
      if (item.targetExists) {
        await rename(item.target, backup);
        backedUp = true;
      }
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }

    try {
      await rename(temporary, item.target);
    } catch (error) {
      await rm(temporary, { force: true });
      if (backedUp) {
        try {
          await rename(backup, item.target);
        } catch (restoreError) {
          throw new AggregateError([error, restoreError], `Repair and rollback failed: ${item.path}`);
        }
      }
      throw error;
    }

    if (backedUp) await rm(backup);
    repaired.push(item.path);
  }
  if (await installTrustedManifest(manifestPath, sourceManifest)) {
    repaired.push('.gala/managed-files.json');
  }
  return repaired;
}

async function installTrustedManifest(target, source) {
  let existing = null;
  try {
    existing = await readFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing?.equals(source)) return false;

  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.gala-repair-${process.pid}`;
  const backup = `${target}.gala-backup-${process.pid}`;
  let backedUp = false;
  try {
    await writeFile(temporary, source, { flag: 'wx' });
    if (existing != null) {
      await rename(target, backup);
      backedUp = true;
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (backedUp) await rename(backup, target);
      throw error;
    }
    if (backedUp) await rm(backup);
    return true;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
