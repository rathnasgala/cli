import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as tar from 'tar';

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 2_048;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function registryUrl(name, version) {
  if (name !== '@rathnasgala/theme' || !EXACT_VERSION.test(version)) {
    throw new TypeError('theme package name and exact version are required');
  }
  return `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

async function boundedBody(response) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_COMPRESSED_BYTES) throw new Error('Theme archive exceeds compressed-size limit');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_COMPRESSED_BYTES) {
      await reader.cancel();
      throw new Error('Theme archive exceeds compressed-size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

function verifyIntegrity(bytes, integrity) {
  const match = /^(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)$/.exec(integrity ?? '');
  if (match == null) throw new Error('Theme package has no supported registry integrity value');
  const actual = createHash(match[1]).update(bytes).digest('base64');
  if (actual !== match[2]) throw new Error('Theme package integrity verification failed');
}

async function validateArchive(archive) {
  let entries = 0;
  let total = 0;
  await new Promise((resolve, reject) => {
    const inspector = tar.t({
      strict: true,
      onReadEntry(entry) {
        entries += 1;
        total += entry.size;
        const normalized = entry.path.replaceAll('\\', '/');
        let error;
        if (normalized !== 'package/' && !normalized.startsWith('package/')) error = 'Theme archive entry is outside package/';
        else if (entry.type === 'SymbolicLink' || entry.type === 'Link') error = 'Theme archive links are forbidden';
        else if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) error = 'Theme archive path is unsafe';
        else if (entries > MAX_ENTRIES || entry.size > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) {
          error = 'Theme archive exceeds extraction limits';
        }
        entry.resume();
        if (error) inspector.abort(new Error(error));
      }
    });
    inspector.once('error', reject);
    inspector.once('close', resolve);
    inspector.end(archive);
  });
}

export async function fetchVerifiedThemePackage({ name, version, fetchImpl = fetch }) {
  const metadataResponse = await fetchImpl(registryUrl(name, version), { headers: { Accept: 'application/json' } });
  if (!metadataResponse.ok) throw new Error(`Theme metadata request failed with HTTP ${metadataResponse.status}`);
  const metadata = await metadataResponse.json();
  if (metadata.name !== name || metadata.version !== version || typeof metadata.dist?.tarball !== 'string') {
    throw new Error('Theme registry metadata does not match the requested package');
  }
  if (!metadata.dist.integrity) throw new Error('Theme package registry metadata has no integrity value');
  const archiveResponse = await fetchImpl(metadata.dist.tarball);
  if (!archiveResponse.ok || archiveResponse.body == null) {
    throw new Error(`Theme archive request failed with HTTP ${archiveResponse.status}`);
  }
  const archive = await boundedBody(archiveResponse);
  verifyIntegrity(archive, metadata.dist.integrity);
  await validateArchive(archive);

  const staging = await mkdtemp(path.join(tmpdir(), 'gala-theme-'));
  try {
    await mkdir(staging, { recursive: true });
    await new Promise((resolve, reject) => {
      const extractor = tar.x({
        cwd: staging,
        strip: 1,
        preservePaths: false,
        strict: true
      });
      extractor.once('error', reject);
      extractor.once('close', resolve);
      extractor.end(archive);
    });
    const payloadRoot = path.join(staging, 'payload');
    const manifest = JSON.parse(await readFile(path.join(payloadRoot, '.gala', 'managed-files.json'), 'utf8'));
    if (manifest.themePackage?.name !== name || manifest.themePackage?.version !== version) {
      throw new Error('Extracted theme manifest does not match registry identity');
    }
    for (const [relative, expected] of Object.entries(manifest.files ?? {})) {
      const sourceRelative = manifest.artifactSources?.[relative] ?? relative;
      const source = path.resolve(payloadRoot, sourceRelative);
      const target = path.resolve(payloadRoot, relative);
      if (path.relative(payloadRoot, source).startsWith('..') || path.relative(payloadRoot, target).startsWith('..')) {
        throw new Error('Theme manifest path is unsafe');
      }
      const actual = createHash('sha256').update(await readFile(source)).digest('hex');
      if (actual !== expected) throw new Error(`Theme file hash mismatch: ${relative}`);
      if (source !== target) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
      }
    }
    return { staging: payloadRoot, cleanupRoot: staging, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
