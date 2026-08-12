import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createPostMetadata,
  isContentId,
  parseFrontmatter,
  slugifyTitle
} from '@rathnasgala/content-validation';
import { stringify } from 'yaml';
import { repositoryEvaluationDate } from './evaluation-date.js';

export async function createPost({ root, title, language, today, now = Date.now }) {
  const siteRoot = path.resolve(root);
  const creationTimestamp = now();
  const publishAfterDate = today ?? await repositoryEvaluationDate({
    root: siteRoot,
    now: () => creationTimestamp
  });
  const metadata = createPostMetadata({
    title,
    language,
    today: publishAfterDate,
    timestamp: creationTimestamp
  });
  const postDirectory = path.join(siteRoot, 'content', 'posts', slugifyTitle(title));
  const mediaDirectory = path.join(postDirectory, 'media');
  const postPath = path.join(postDirectory, `index.${metadata.language}.md`);

  await mkdir(postDirectory, { recursive: true });
  const variants = (await readdir(postDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^index\.[^.]+\.md$/.test(entry.name));
  const existingIds = new Set();
  for (const variant of variants) {
    const variantPath = path.join(postDirectory, variant.name);
    const parsed = parseFrontmatter(await readFile(variantPath, 'utf8'));
    if (parsed.errors.length > 0) {
      throw new Error(`Existing variant has invalid frontmatter: ${variantPath}`);
    }
    if (!isContentId(parsed.data.id)) {
      throw new Error(`Existing variant is missing a valid article id: ${variantPath}`);
    }
    existingIds.add(parsed.data.id);
  }
  if (existingIds.size > 1) {
    throw new Error(`Existing variants have conflicting article ids: ${postDirectory}`);
  }
  if (existingIds.size === 1) metadata.id = existingIds.values().next().value;

  await mkdir(mediaDirectory, { recursive: true });
  const source = `---\n${stringify(metadata).trimEnd()}\n---\n\n# ${title}\n`;
  await writeFile(postPath, source, { encoding: 'utf8', flag: 'wx' });
  return { metadata, postPath, mediaDirectory };
}
