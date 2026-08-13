import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';

export async function writeRegisteredSiteConfiguration(root, { siteId, canonicalBaseUrl, topology }) {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(siteId)) throw new TypeError('siteId is invalid');
  if (topology !== 'provider-default') throw new TypeError('Only provider-default topology is implemented');
  const canonical = new URL(canonicalBaseUrl);
  if (canonical.protocol !== 'https:' || canonical.username || canonical.password || canonical.search || canonical.hash) {
    throw new TypeError('canonicalBaseUrl must be credential-free HTTPS');
  }
  const target = path.resolve(root, 'site.config.yml');
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new TypeError('site.config.yml must be a regular file');
  const config = parse(await readFile(target, 'utf8'));
  if (config?.schemaVersion !== 1 || config.site == null || config.hosting == null) {
    throw new TypeError('Unsupported site configuration schema');
  }
  config.site.id = siteId;
  config.hosting.provider = 'github-pages';
  config.hosting.topology = topology;
  config.hosting.canonicalBaseUrl = canonical.href.replace(/\/$/, '');
  config.hosting.pathPrefix = canonical.pathname === '/' ? '/' : canonical.pathname.replace(/\/$/, '');
  const temporary = `${target}.gala-register-${process.pid}`;
  const backup = `${target}.gala-backup-${process.pid}`;
  try {
    await writeFile(temporary, stringify(config), { flag: 'wx' });
    await rename(target, backup);
    try { await rename(temporary, target); }
    catch (error) { await rename(backup, target); throw error; }
    await rm(backup);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return config;
}
