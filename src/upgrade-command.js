import { lstat, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';

import { repairFramework } from './doctor-command.js';
import { fetchVerifiedThemePackage } from './theme-package.js';

const NAME = '@rathnasgala/theme';
const ACTION_WORKFLOW = '.github/workflows/publish.yml';
const ACTION_REFERENCE = /rathnasgala\/publish\/\.github\/workflows\/publish\.yml@v([1-9][0-9]*)/g;
const ACTION_TAG = /^v([1-9][0-9]*)(?:\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)?$/;

async function registryMetadata(fetchImpl) {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(NAME)}`, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Theme registry request failed with HTTP ${response.status}`);
  return response.json();
}

export async function inspectActionUpgrade({ root, fetchImpl = fetch }) {
  const workflowPath = path.resolve(root, ACTION_WORKFLOW);
  const metadata = await lstat(workflowPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new TypeError('Publish workflow must be a regular file');
  }
  const workflow = await readFile(workflowPath, 'utf8');
  const majors = [...workflow.matchAll(ACTION_REFERENCE)].map((match) => Number(match[1]));
  if (majors.length === 0 || new Set(majors).size !== 1) {
    throw new Error('Publish workflow must reference exactly one Gala action major');
  }
  const response = await fetchImpl('https://api.github.com/repos/rathnasgala/publish/tags?per_page=100', {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }
  });
  if (!response.ok) throw new Error(`Action release lookup failed with HTTP ${response.status}`);
  const tags = await response.json();
  if (!Array.isArray(tags)) throw new TypeError('Action release response must be an array');
  const releasedMajors = tags.map((tag) => ACTION_TAG.exec(tag?.name)?.[1])
    .filter((major) => major != null).map(Number);
  const currentMajor = majors[0];
  const latestMajor = releasedMajors.length === 0 ? currentMajor : Math.max(...releasedMajors);
  return Object.freeze({ currentMajor, latestMajor, newerAvailable: latestMajor > currentMajor });
}

export async function upgradeTheme({ root, channel, confirm, fetchImpl = fetch }) {
  const configPath = path.resolve(root, 'site.config.yml');
  const config = parse(await readFile(configPath, 'utf8'));
  const installed = config?.framework?.themePackage?.version;
  const [metadata, action] = await Promise.all([
    registryMetadata(fetchImpl), inspectActionUpgrade({ root, fetchImpl })
  ]);
  const selectedChannel = channel ?? (metadata['dist-tags']?.next === installed ? 'next' : 'latest');
  if (!['latest', 'next'].includes(selectedChannel)) throw new TypeError('theme channel must be latest or next');
  const version = metadata['dist-tags']?.[selectedChannel];
  if (typeof version !== 'string') throw new Error(`Theme channel ${selectedChannel} has no resolved version`);
  if (version === installed) return { changed: false, channel: selectedChannel, version, repaired: [], action };
  if (typeof confirm !== 'function' || !await confirm({ name: NAME, installed, channel: selectedChannel, version })) {
    return { changed: false, cancelled: true, channel: selectedChannel, version, repaired: [], action };
  }
  const downloaded = await fetchVerifiedThemePackage({ name: NAME, version, fetchImpl });
  try {
    if (!downloaded.manifest.themePackage.availableDesignThemes?.includes(config?.design?.theme)) {
      throw new Error(`Visual theme ${String(config?.design?.theme)} is unavailable in ${NAME}@${version}`);
    }
    config.framework.themePackage = { name: NAME, version };
    const repaired = await repairFramework(root, downloaded.staging, {
      siteConfiguration: stringify(config)
    });
    return { changed: true, channel: selectedChannel, version, repaired, action };
  } finally {
    await rm(downloaded.cleanupRoot, { recursive: true, force: true });
  }
}
