import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalizeLanguageTag,
  createPostMetadata,
  isContentId,
  parseFrontmatter,
  repositoryEvaluationDate,
  slugifyTitle
} from '@rathnasgala/content-validation';
import { stringify } from 'yaml';

import { UsageError } from '../cli/args.js';
import { cliCommand } from '../cli/invocation.js';
import { postUrl, readPublication } from '../publication.js';

/**
 * Starts a post.
 *
 * The article id is the part worth being careful about: every language variant of one post shares
 * it, and it is what lets a folder be renamed without the published URL moving. So an existing
 * variant's id is adopted rather than a new one minted, and conflicting ids are refused instead of
 * guessed at.
 */
export async function createPost({
  terminal, options, cwd = process.cwd(), now = Date.now, write = writeFile
}) {
  const root = path.resolve(options.value('root') ?? cwd);
  const publication = await readPublication(root);
  const translationSlug = options.value('translation-of');
  const requestedLanguages = await languages({
    terminal,
    language: options.value('language'),
    languages: options.value('languages'),
    translation: translationSlug != null,
    defaultLanguage: publication?.defaultLanguage ?? 'en'
  });
  const existingTranslation = translationSlug == null
    ? null
    : await articleBySlug(root, translationSlug);
  const copiedSourceTitle = options.positional[0] == null && existingTranslation?.title != null;
  const title = options.positional[0]
    ?? existingTranslation?.title
    ?? await terminal.ask('What is this post called?');
  if (typeof title !== 'string' || title.trim() === '') throw new UsageError('a post needs a title');

  const timestamp = now();
  const publishAfterDate = options.value('today')
    ?? await repositoryEvaluationDate({ root, now: () => timestamp });
  const directory = existingTranslation?.directory
    ?? path.join(root, 'content', 'posts', slugifyTitle(title));
  const existing = existingTranslation ?? await readArticle(directory, { allowMissing: true });
  const metadata = requestedLanguages.map((language) => createPostMetadata({
    title: title.trim(), language, today: publishAfterDate, timestamp
  }));
  const articleId = existing?.id ?? metadata[0].id;
  metadata.forEach((entry) => { entry.id = articleId; });
  const pending = metadata.filter((entry) => !existing?.languages.has(entry.language));
  const unchanged = metadata.filter((entry) => existing?.languages.has(entry.language));

  for (const entry of unchanged) {
    const file = existing.languages.get(entry.language).file;
    terminal.note(`${languageName(entry.language)} already exists at ${path.relative(cwd, file)}; left unchanged.`);
  }
  if (pending.length === 0) {
    terminal.done('Every requested language already exists');
    return {
      file: unchanged.length === 1 ? existing.languages.get(unchanged[0].language).file : undefined,
      files: [],
      metadata: unchanged.length === 1 ? existing.languages.get(unchanged[0].language).data : undefined
    };
  }

  if (existing != null) {
    terminal.step(`Adding ${pending.map((entry) => languageName(entry.language)).join(', ')} to “${existing.title}”`);
  }
  await mkdir(path.join(directory, 'media'), { recursive: true });
  const variants = pending.map((entry) => ({
    file: path.join(directory, `index.${entry.language}.md`),
    metadata: entry
  }));
  const created = [];
  try {
    for (const variant of variants) {
      // `wx` is the last race-safe guard: a concurrent invocation can never be overwritten.
      await write(variant.file,
        `---\n${stringify(variant.metadata).trimEnd()}\n---\n\n# ${title.trim()}\n`,
        { encoding: 'utf8', flag: 'wx' });
      created.push(variant.file);
    }
  } catch (error) {
    // Keep the write failure actionable even if an unusual filesystem error prevents cleanup.
    await Promise.allSettled(created.map((file) => rm(file, { force: true })));
    throw error;
  }

  terminal.done(existing == null
    ? (requestedLanguages.length === 1 ? 'Post created' : 'Multilingual post created')
    : (pending.length === 1 ? 'Translation created' : 'Translations created'));
  if (created.length === 1) terminal.result(path.relative(cwd, created[0]));
  else {
    terminal.result(`${created.length} language variants created`);
    created.forEach((file) => terminal.note(path.relative(cwd, file)));
  }
  if (existing != null || requestedLanguages.length > 1) {
    terminal.note('These language variants share one article ID, URL name, interactions, and analytics.');
  }
  if (requestedLanguages.length > 1) {
    terminal.note('Open each file to localize each title and body.');
  } else if (copiedSourceTitle) {
    terminal.note(
      'Gala copied the existing title into this translation; localize its title and body before publishing.'
    );
  }

  // Where it will be, once published. The language segment is not obvious from anything the writer
  // typed, and hunting for your own post is a poor first minute with a publishing tool.
  for (const entry of pending) {
    const address = postUrl(publication, path.basename(directory), entry.language);
    if (address != null) terminal.note(`${languageName(entry.language)} will appear at ${address}`);
  }

  terminal.blank();
  terminal.note(`write below the second --- line, then: ${cliCommand('preview')}`);
  return {
    file: created.length === 1 ? created[0] : undefined,
    files: created,
    metadata: pending.length === 1 ? pending[0] : undefined,
    variants: pending
  };
}

async function languages({ terminal, language, languages: multiple, translation, defaultLanguage }) {
  if (language != null && multiple != null) {
    throw new UsageError('Use either --language or --languages, not both.');
  }
  let requested;
  if (language != null) requested = [language];
  else if (multiple != null) requested = multiple.split(',').map((entry) => entry.trim());
  else if (translation) {
    if (!terminal.interactive) {
      throw new UsageError('A translation needs --language <tag> or --languages <tag,tag>.');
    }
    requested = [(await terminal.ask('What language are you adding? (for example ta or fr)')).trim()];
  } else requested = [defaultLanguage];
  if (requested.length === 0 || requested.some((entry) => entry === '')) {
    throw new UsageError('--languages needs comma-separated language tags, for example en,ta,fr.');
  }
  const canonical = requested.map((entry) => {
    try {
      return canonicalizeLanguageTag(entry);
    } catch {
      throw new UsageError(`Invalid language ${JSON.stringify(entry)}. Use a BCP-47 tag such as en, ta, or pt-BR.`);
    }
  });
  const duplicate = canonical.find((entry, index) => canonical.indexOf(entry) !== index);
  if (duplicate != null) throw new UsageError(`Language ${duplicate} was requested more than once.`);
  return canonical;
}

async function articleBySlug(root, slug) {
  const postsRoot = path.join(root, 'content', 'posts');
  const entries = await entriesAt(postsRoot, { allowMissing: true });
  const posts = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const found = entries.find((entry) => entry.isDirectory() && entry.name === slug);
  if (!found) {
    const available = posts.length === 0 ? 'No posts exist yet.' : `Available posts: ${posts.join(', ')}`;
    throw new UsageError(`No post uses slug ${slug}. ${available}`);
  }
  const article = await readArticle(path.join(postsRoot, found.name));
  if (article == null || article.languages.size === 0) {
    throw new UsageError(`Post ${slug} has no language variants to translate.`);
  }
  return article;
}

/** The identity and languages shared by every variant already in this folder. */
async function readArticle(directory, { allowMissing = false } = {}) {
  const variants = (await entriesAt(directory, { allowMissing }))
    .filter((entry) => entry.isFile() && /^index\.[^.]+\.md$/.test(entry.name));
  if (variants.length === 0) return null;

  const ids = new Set();
  const found = new Map();
  for (const variant of variants) {
    const file = path.join(directory, variant.name);
    const parsed = parseFrontmatter(await readFile(file, 'utf8'));
    if (parsed.errors.length > 0) throw new Error(`${file} has invalid frontmatter`);
    if (!isContentId(parsed.data.id)) throw new Error(`${file} is missing a valid article id`);
    ids.add(parsed.data.id);
    let language;
    try {
      language = canonicalizeLanguageTag(parsed.data.language);
    } catch {
      throw new Error(`${file} is missing a valid language`);
    }
    let filenameLanguage;
    try {
      filenameLanguage = canonicalizeLanguageTag(variant.name.slice(6, -3));
    } catch {
      throw new Error(`${file} has an invalid language in its filename`);
    }
    if (language !== filenameLanguage) {
      throw new Error(`${file} has a language that does not match its filename`);
    }
    if (found.has(language)) {
      throw new Error(`${directory} has more than one variant for language ${language}`);
    }
    found.set(language, { file, data: parsed.data });
  }
  if (ids.size > 1) throw new Error(`${directory} has variants with conflicting article ids`);
  const first = found.values().next().value;
  return {
    directory,
    id: ids.values().next().value,
    title: first.data.title,
    languages: found
  };
}

async function entriesAt(directory, { allowMissing = false } = {}) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return [];
    throw error;
  }
}

function languageName(language) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
}
