import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createPostMetadata,
  isContentId,
  parseFrontmatter,
  repositoryEvaluationDate,
  slugifyTitle
} from '@rathnasgala/content-validation';
import { stringify } from 'yaml';

import { UsageError } from '../cli/args.js';
import { postUrl, readPublication } from '../publication.js';

/**
 * Starts a post.
 *
 * The article id is the part worth being careful about: every language variant of one post shares
 * it, and it is what lets a folder be renamed without the published URL moving. So an existing
 * variant's id is adopted rather than a new one minted, and conflicting ids are refused instead of
 * guessed at.
 */
export async function createPost({ terminal, options, cwd = process.cwd(), now = Date.now }) {
  const root = path.resolve(options.value('root') ?? cwd);
  const title = options.positional[0] ?? await terminal.ask('What is this post called?');
  if (typeof title !== 'string' || title.trim() === '') throw new UsageError('a post needs a title');

  const timestamp = now();
  const language = options.value('language') ?? 'en';
  const publishAfterDate = options.value('today')
    ?? await repositoryEvaluationDate({ root, now: () => timestamp });

  const metadata = createPostMetadata({ title, language, today: publishAfterDate, timestamp });
  const directory = path.join(root, 'content', 'posts', slugifyTitle(title));
  const file = path.join(directory, `index.${metadata.language}.md`);

  await mkdir(directory, { recursive: true });
  const existing = await siblingId(directory);
  if (existing != null) metadata.id = existing;
  await mkdir(path.join(directory, 'media'), { recursive: true });

  // `wx` so an existing variant is never overwritten by a second run.
  await writeFile(file, `---\n${stringify(metadata).trimEnd()}\n---\n\n# ${title}\n`, {
    encoding: 'utf8', flag: 'wx'
  });

  terminal.done('Post created');
  terminal.result(path.relative(cwd, file));

  // Where it will be, once published. The language segment is not obvious from anything the writer
  // typed, and hunting for your own post is a poor first minute with a publishing tool.
  const address = postUrl(await readPublication(root), path.basename(directory), metadata.language);
  if (address != null) terminal.note(`will appear at ${address}`);

  terminal.blank();
  terminal.note('write below the second --- line, then: npx --yes @rathnasgala/cli@latest preview');
  return { file, metadata };
}

/** The id shared by every language variant already in this folder. */
async function siblingId(directory) {
  const variants = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^index\.[^.]+\.md$/.test(entry.name));

  const ids = new Set();
  for (const variant of variants) {
    const file = path.join(directory, variant.name);
    const parsed = parseFrontmatter(await readFile(file, 'utf8'));
    if (parsed.errors.length > 0) throw new Error(`${file} has invalid frontmatter`);
    if (!isContentId(parsed.data.id)) throw new Error(`${file} is missing a valid article id`);
    ids.add(parsed.data.id);
  }
  if (ids.size > 1) throw new Error(`${directory} has variants with conflicting article ids`);
  return ids.size === 1 ? ids.values().next().value : null;
}
