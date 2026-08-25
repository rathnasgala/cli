import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

/**
 * Where a publication and its posts actually live on the web.
 *
 * The CLI knew every part of this and never said it: `new` printed a file path, `publish` said the
 * site would appear shortly, and the writer was left to assemble
 * `{canonicalBaseUrl}{pathPrefix}/{language}/{slug}/` themselves. That is easy to get wrong — the
 * language segment is not obvious from anything they typed — and being unable to find your own post
 * is a poor first minute with a publishing tool.
 */
export async function readPublication(root) {
  try {
    const configuration = parse(await readFile(path.join(root, 'site.config.yml'), 'utf8'));
    const base = configuration?.hosting?.canonicalBaseUrl;
    if (typeof base !== 'string') return null;
    const prefix = typeof configuration?.hosting?.pathPrefix === 'string'
      ? configuration.hosting.pathPrefix
      : '/';
    return {
      siteId: configuration?.site?.id,
      repository: configuration?.site?.repository,
      name: configuration?.site?.name,
      defaultLanguage: configuration?.site?.defaultLanguage ?? 'en',
      url: `${base.replace(/\/$/, '')}${prefix === '/' ? '' : prefix}/`
    };
  } catch {
    // Not being able to read it is never worth failing a command over; the caller simply says less.
    return null;
  }
}

export function postUrl(publication, slug, language) {
  if (publication == null) return null;
  return `${publication.url}${language ?? publication.defaultLanguage}/${slug}/`;
}
