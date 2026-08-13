import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSiteConfigurationOptions } from '@rathnasgala/content-validation';
import { parseDocument } from 'yaml';

import { scaffoldOptionNames } from './scaffold-options.js';

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export async function configureSite(root, designOptions) {
  const configPath = path.resolve(root, 'site.config.yml');
  const relation = path.relative(path.resolve(root), configPath);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new TypeError('site.config.yml escapes the site root');
  }

  const metadata = await lstat(configPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError('site.config.yml must be a regular file');
  }

  let config;
  let document;
  try {
    document = parseDocument(await readFile(configPath, 'utf8'));
    if (document.errors.length > 0) throw document.errors[0];
    config = document.toJS();
  } catch (error) {
    throw new TypeError(`Invalid site.config.yml: ${error.message}`);
  }
  if (config.schemaVersion !== 1 || config.design == null || Array.isArray(config.design)) {
    throw new TypeError('Unsupported site configuration schema');
  }
  if (Object.keys(designOptions).length === 0) return config;

  const siteOptions = Object.fromEntries(
    Object.entries(designOptions).filter(([name]) => !scaffoldOptionNames.includes(name))
  );
  const normalizedSiteOptions = normalizeSiteConfigurationOptions(siteOptions);

  for (const [name, value] of Object.entries(designOptions)) {
    if (scaffoldOptionNames.includes(name)) {
      config.design[name] = nonEmptyString(value, `Design option ${name}`);
      document.setIn(['design', name], config.design[name]);
    }
  }
  if (normalizedSiteOptions.siteName != null) {
    config.site.name = normalizedSiteOptions.siteName;
    document.setIn(['site', 'name'], config.site.name);
  }
  if (normalizedSiteOptions.siteAuthor != null) {
    config.site.author = normalizedSiteOptions.siteAuthor;
    document.setIn(['site', 'author'], config.site.author);
  }
  if (normalizedSiteOptions.defaultLanguage != null) {
    config.site.defaultLanguage = normalizedSiteOptions.defaultLanguage;
    document.setIn(['site', 'defaultLanguage'], config.site.defaultLanguage);
  }
  if (normalizedSiteOptions.timezone != null) {
    config.site.timezone = normalizedSiteOptions.timezone;
    document.setIn(['site', 'timezone'], config.site.timezone);
  }
  if (normalizedSiteOptions.shareTargets != null) {
    config.sharing.targets = normalizedSiteOptions.shareTargets;
    document.setIn(['sharing', 'targets'], config.sharing.targets);
  }
  if (normalizedSiteOptions.socialProfiles != null) {
    config.sharing.socialProfiles = normalizedSiteOptions.socialProfiles;
    document.setIn(['sharing', 'socialProfiles'], config.sharing.socialProfiles);
  }

  const temporary = `${configPath}.gala-config-${process.pid}`;
  const backup = `${configPath}.gala-backup-${process.pid}`;
  try {
    await writeFile(temporary, String(document), { flag: 'wx' });
    await rename(configPath, backup);
    try {
      await rename(temporary, configPath);
    } catch (error) {
      await rename(backup, configPath);
      throw error;
    }
    await rm(backup);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return config;
}
