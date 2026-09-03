import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

import { galaApi } from '../api/gala.js';
import { accountForCommand } from '../auth/checkout-profile.js';
import { authenticatedProfile } from '../auth/profiles.js';
import { UsageError } from '../cli/args.js';
import { cliCommand } from '../cli/invocation.js';
import { readPublication } from '../publication.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CSS_PATH = path.join('static', 'assets', 'appearance-theme.css');

export async function theme({ terminal, options, cwd = process.cwd() }) {
  const root = path.resolve(options.value('root') ?? cwd);
  const publication = await readPublication(root);
  if (!publication || !ULID.test(publication.siteId ?? '')) {
    throw new UsageError('Run this inside a registered Gala publication, or pass --root.');
  }
  const [action = 'status', value, ...extra] = options.positional;
  if (extra.length > 0 || !['status', 'list', 'use'].includes(action)) {
    throw new UsageError(`Use: ${cliCommand('theme [status|list|use <theme-id|built-in>]')}`);
  }
  if (action === 'use' && value == null) throw new UsageError('theme use needs a theme ID or built-in');
  if (action !== 'use' && value != null) throw new UsageError(`theme ${action} takes no theme ID`);
  if (action !== 'use' && options.value('version') != null) {
    throw new UsageError('--version is only valid with theme use');
  }

  const account = await accountForCommand(options, root, { terminal });
  const profile = await authenticatedProfile({ name: account, terminal });
  const api = galaApi({ baseUrl: profile.gala.apiBaseUrl, token: profile.gala.accessToken });
  const catalog = validateCatalog(await api.appearanceThemeCatalog(publication.siteId));
  const configPath = path.join(root, 'site.config.yml');
  await assertRegularOrMissing(configPath);
  const source = await readFile(configPath, 'utf8');
  const local = readLocalConfiguration(source);

  if (action === 'status') {
    terminal.result(local.selection == null
      ? 'Built-in Gala appearance'
      : `${local.selection.id} ${local.selection.version}`);
    terminal.note(`Local framework ${local.frameworkVersion}`);
    if (!sameSelection(local.selection, catalog.selected)) {
      terminal.note('The local selection differs from GitHub; preview it, then publish or discard the local change.');
    }
    return local.selection;
  }

  if (action === 'list') {
    terminal.result(`Official themes for framework ${local.frameworkVersion}`);
    if (catalog.releases.length === 0) terminal.note('No active official themes are registered.');
    for (const release of catalog.releases) {
      const compatible = supports(release, local.frameworkVersion);
      terminal.note(`${compatible ? 'available' : 'upgrade required'}  ${release.themeId} ${release.version} — ${release.displayName}`);
      if (!compatible) terminal.note(`  requires framework ${release.minimumFrameworkVersion} to before ${release.maximumFrameworkVersionExclusive}`);
    }
    return catalog.releases;
  }

  if (value === 'built-in') {
    if (options.value('version') != null) throw new UsageError('--version cannot be used with built-in');
    if (local.selection == null) {
      terminal.note('Already using the built-in Gala appearance.');
      return { changed: false, selection: null };
    }
    await replaceFile(configPath, removeAppearanceTheme(source));
    terminal.done('Staged the built-in Gala appearance');
    showNextSteps(terminal);
    return { changed: true, selection: null };
  }

  if (!THEME_ID.test(value)) throw new UsageError('Theme IDs use lowercase letters, numbers and single hyphens.');
  const requestedVersion = options.value('version');
  if (requestedVersion != null && !VERSION.test(requestedVersion)) {
    throw new UsageError('--version must be an exact semantic version such as 1.0.0');
  }
  const matching = catalog.releases.filter((release) => release.themeId === value
    && (requestedVersion == null || release.version === requestedVersion));
  if (matching.length === 0) {
    const available = [...new Set(catalog.releases.map((release) => release.themeId))];
    throw new UsageError(available.length === 0
      ? 'No active official themes are registered.'
      : `Theme ${value}${requestedVersion ? ` ${requestedVersion}` : ''} is not active. Available themes: ${available.join(', ')}.`);
  }
  const compatible = matching.filter((release) => supports(release, local.frameworkVersion));
  if (compatible.length === 0) {
    const minimum = matching.sort((left, right) => compareVersions(
      left.minimumFrameworkVersion, right.minimumFrameworkVersion))[0].minimumFrameworkVersion;
    throw new UsageError(`Theme ${value} requires Gala framework ${minimum} or newer; this publication has ${local.frameworkVersion}. `
      + `Run ${cliCommand('upgrade --yes')}, publish the upgrade, then try again.`);
  }
  const release = compatible.sort((left, right) => compareVersions(right.version, left.version))[0];
  if (!supports(release, catalog.frameworkVersion)) {
    throw new UsageError(`The local framework ${local.frameworkVersion} supports ${release.displayName}, but GitHub still has framework ${catalog.frameworkVersion}. `
      + `Run ${cliCommand('publish')} to send the framework upgrade, wait for that build, then try again.`);
  }
  const preview = validatePreview(
    await api.appearanceThemePreview(publication.siteId, release.themeId, release.version), release);
  const baseline = local.selection?.baseManagedCssBytes ?? local.managedCssBytes;
  const nextBudget = Math.max(local.managedCssBytes, baseline + release.cssBytes);
  const selection = {
    id: release.themeId,
    version: release.version,
    repository: `${release.repositoryOwner}/${release.repositoryName}`,
    commitSha: release.commitSha,
    cssSha256: release.cssSha256,
    cssBytes: release.cssBytes,
    baseManagedCssBytes: baseline,
  };
  const updated = applyAppearanceTheme(source, selection, nextBudget);
  await replaceThemeFiles(root, source, updated, Buffer.from(preview.css, 'utf8'));
  terminal.done(`Staged ${release.displayName} ${release.version}`);
  terminal.note(`Verified ${release.repositoryOwner}/${release.repositoryName}@${release.commitSha.slice(0, 12)} and ${release.cssSha256.slice(0, 12)}…`);
  showNextSteps(terminal);
  return { changed: true, selection };
}

function showNextSteps(terminal) {
  terminal.note('Nothing has been committed or sent to GitHub.');
  terminal.note(`Run ${cliCommand('preview')}, then ${cliCommand('publish')} when the result is approved.`);
}

function validateCatalog(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
      || !VERSION.test(value.frameworkVersion ?? '') || !Array.isArray(value.releases)) {
    throw new TypeError('Gala returned an invalid official theme catalog');
  }
  return {
    frameworkVersion: value.frameworkVersion,
    selected: value.selected == null ? null : validateSelection(value.selected),
    releases: value.releases.map(validateRelease),
  };
}

function validateRelease(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
      || !THEME_ID.test(value.themeId ?? '') || !VERSION.test(value.version ?? '')
      || typeof value.displayName !== 'string' || value.displayName.trim() === ''
      || value.repositoryOwner !== 'rathnasgala'
      || typeof value.repositoryName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.repositoryName)
      || !COMMIT.test(value.commitSha ?? '') || !VERSION.test(value.minimumFrameworkVersion ?? '')
      || !VERSION.test(value.maximumFrameworkVersionExclusive ?? '')
      || !SHA256.test(value.cssSha256 ?? '')
      || !Number.isSafeInteger(value.cssBytes) || value.cssBytes < 1 || value.cssBytes > 32768
      || value.status !== 'ACTIVE') {
    throw new TypeError('Gala returned an invalid official theme release');
  }
  return value;
}

function validateSelection(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
      || !THEME_ID.test(value.themeId ?? '') || !VERSION.test(value.version ?? '')) {
    throw new TypeError('Gala returned an invalid official theme selection');
  }
  return value;
}

function validatePreview(value, release) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
      || value.themeId !== release.themeId || value.version !== release.version
      || value.cssSha256 !== release.cssSha256 || value.cssBytes !== release.cssBytes
      || typeof value.css !== 'string') {
    throw new TypeError('Gala returned an invalid official theme preview');
  }
  const bytes = Buffer.from(value.css, 'utf8');
  if (bytes.length !== release.cssBytes
      || createHash('sha256').update(bytes).digest('hex') !== release.cssSha256) {
    throw new TypeError('Official theme preview failed integrity verification');
  }
  return value;
}

function readLocalConfiguration(source) {
  let config;
  try {
    config = parse(source);
  } catch {
    throw new TypeError('site.config.yml is invalid');
  }
  const frameworkVersion = config?.framework?.themePackage?.version;
  const managedCssBytes = config?.performance?.budgets?.managedCssBytes;
  if (!VERSION.test(frameworkVersion ?? '')) throw new TypeError('site.config.yml has no valid framework version');
  if (!Number.isSafeInteger(managedCssBytes) || managedCssBytes < 1) {
    throw new TypeError('site.config.yml has no valid managed CSS budget');
  }
  return {
    frameworkVersion,
    managedCssBytes,
    selection: config.appearanceTheme == null ? null : validateLocalSelection(config.appearanceTheme),
  };
}

function validateLocalSelection(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)
      || !THEME_ID.test(value.id ?? '') || !VERSION.test(value.version ?? '')
      || typeof value.repository !== 'string' || !/^rathnasgala\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.repository)
      || !COMMIT.test(value.commitSha ?? '') || !SHA256.test(value.cssSha256 ?? '')
      || !Number.isSafeInteger(value.cssBytes) || value.cssBytes < 1 || value.cssBytes > 32768
      || !Number.isSafeInteger(value.baseManagedCssBytes) || value.baseManagedCssBytes < 1) {
    throw new TypeError('site.config.yml has an invalid appearanceTheme selection');
  }
  return value;
}

function supports(release, frameworkVersion) {
  return compareVersions(frameworkVersion, release.minimumFrameworkVersion) >= 0
    && compareVersions(frameworkVersion, release.maximumFrameworkVersionExclusive) < 0;
}

function compareVersions(left, right) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (!a || !b) throw new TypeError('An official theme has an invalid semantic version');
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a[4] == null || b[4] == null) return a[4] == null ? (b[4] == null ? 0 : 1) : -1;
  const leftIdentifiers = a[4].split('.');
  const rightIdentifiers = b[4].split('.');
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    if (leftIdentifiers[index] == null) return -1;
    if (rightIdentifiers[index] == null) return 1;
    if (leftIdentifiers[index] === rightIdentifiers[index]) continue;
    const leftNumber = /^\d+$/.test(leftIdentifiers[index]);
    const rightNumber = /^\d+$/.test(rightIdentifiers[index]);
    if (leftNumber && rightNumber) return Math.sign(Number(leftIdentifiers[index]) - Number(rightIdentifiers[index]));
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return leftIdentifiers[index].localeCompare(rightIdentifiers[index]);
  }
  return 0;
}

function sameSelection(local, remote) {
  if (local == null || remote == null) return local == null && remote == null;
  return local.id === remote.themeId && local.version === remote.version;
}

function removeAppearanceTheme(source) {
  const match = /^appearanceTheme:\s*$/m.exec(source);
  if (!match) return source;
  const after = source.slice(match.index + match[0].length);
  const next = /\n(?=[^\s#][^\n]*$)/m.exec(after);
  const end = next ? match.index + match[0].length + next.index + 1 : source.length;
  return `${source.slice(0, match.index)}${source.slice(end)}`.replace(/\n{3,}/g, '\n\n');
}

function applyAppearanceTheme(source, selection, managedCssBytes) {
  let updated = removeAppearanceTheme(source);
  const budget = /^(\s+managedCssBytes:\s*)([0-9]+)(\s*)$/m;
  if (!budget.test(updated)) throw new TypeError('site.config.yml has no managed CSS budget');
  updated = updated.replace(budget, (_, prefix, _value, suffix) => (
    `${prefix}${managedCssBytes}${suffix}`
  ));
  if (!updated.endsWith('\n')) updated += '\n';
  return `${updated}appearanceTheme:\n`
    + `  id: ${selection.id}\n`
    + `  version: ${selection.version}\n`
    + `  repository: "${selection.repository}"\n`
    + `  commitSha: ${selection.commitSha}\n`
    + `  cssSha256: ${selection.cssSha256}\n`
    + `  cssBytes: ${selection.cssBytes}\n`
    + `  baseManagedCssBytes: ${selection.baseManagedCssBytes}\n`;
}

async function replaceThemeFiles(root, previousConfig, nextConfig, css) {
  const configPath = path.join(root, 'site.config.yml');
  const cssPath = path.join(root, CSS_PATH);
  await assertRegularOrMissing(cssPath);
  const previousCss = await readFile(cssPath).catch((failure) => {
    if (failure.code === 'ENOENT') return null;
    throw failure;
  });
  try {
    await replaceFile(cssPath, css);
    await replaceFile(configPath, nextConfig);
  } catch (failure) {
    if (previousCss == null) await rm(cssPath, { force: true });
    else await replaceFile(cssPath, previousCss);
    await replaceFile(configPath, previousConfig);
    throw failure;
  }
}

async function assertRegularOrMissing(target) {
  try {
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${path.relative(process.cwd(), target)} is not a regular file`);
    }
  } catch (failure) {
    if (failure.code !== 'ENOENT') throw failure;
  }
}

async function replaceFile(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.gala-theme-${process.pid}`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, target);
  } catch (failure) {
    await rm(temporary, { force: true });
    throw failure;
  }
}
