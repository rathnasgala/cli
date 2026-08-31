import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createContentId, parseFrontmatter, validateContent
} from '@rathnasgala/content-validation';

import { createPost } from '../src/commands/new.js';

function collector({ interactive = false, answers = [] } = {}) {
  const lines = [];
  const record = (kind) => (message) => lines.push([kind, message]);
  return {
    lines,
    said: (kind) => lines.filter(([entry]) => entry === kind).map(([, message]) => message),
    terminal: {
      interactive,
      step: record('step'), done: record('done'), result: record('result'),
      note: record('note'), blank() {},
      async ask(question) {
        lines.push(['ask', question]);
        if (!interactive || answers.length === 0) throw new Error(`${question} - no terminal to ask`);
        return answers.shift();
      }
    }
  };
}

function supplied(positional, values = {}) {
  return {
    positional,
    value(name) { return values[name]; }
  };
}

async function publication(defaultLanguage = 'en') {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-new-'));
  await writeFile(path.join(root, 'site.config.yml'), [
    'site:',
    `  defaultLanguage: ${defaultLanguage}`,
    'hosting:',
    '  canonicalBaseUrl: https://writer.github.io',
    '  pathPrefix: /notes'
  ].join('\n'));
  return root;
}

async function frontmatter(file) {
  const parsed = parseFrontmatter(await readFile(file, 'utf8'));
  assert.deepEqual(parsed.errors, []);
  return parsed.data;
}

test('new points zero-install users to an executable preview command', async () => {
  const root = await publication();
  const notes = [];

  await createPost({
    terminal: {
      done() {}, result() {}, blank() {}, note(message) { notes.push(message); }
    },
    options: {
      positional: ['Your first post'],
      value(name) { return name === 'today' ? '2026-08-29' : undefined; }
    },
    cwd: root,
    now: () => 1787990400000
  });

  assert.match(notes.join('\n'), /npx --yes @rathnasgala\/cli@latest preview/);
  assert.doesNotMatch(notes.join('\n'), /then: gala preview/);
});

test('new uses the publication default language when no language option is supplied', async () => {
  const root = await publication('fr');
  const { terminal } = collector();

  const created = await createPost({
    terminal,
    options: supplied(['Une idée durable'], { today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000
  });

  assert.equal(path.basename(created.file), 'index.fr.md');
  assert.equal((await frontmatter(created.file)).language, 'fr');
});

test('an explicit translation reuses the existing article id and accepts its localized title', async () => {
  const root = await publication();
  const source = await createPost({
    terminal: collector().terminal,
    options: supplied(['A durable idea'], { language: 'en', today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000
  });
  const output = collector();

  const translation = await createPost({
    terminal: output.terminal,
    options: supplied(['நீடித்த ஒரு எண்ணம்'], {
      language: 'ta', 'translation-of': 'a-durable-idea', today: '2026-08-30'
    }),
    cwd: root,
    now: () => 1788048001000
  });

  assert.equal(translation.file,
    path.join(root, 'content', 'posts', 'a-durable-idea', 'index.ta.md'));
  assert.equal((await frontmatter(translation.file)).title, 'நீடித்த ஒரு எண்ணம்');
  assert.equal((await frontmatter(translation.file)).id, (await frontmatter(source.file)).id);
  assert.match(output.said('note').join('\n'), /share.*interactions, and analytics/i);

  const validation = await validateContent({ root, today: '2026-08-30' });
  assert.deepEqual(validation.flatMap((entry) => entry.errors), []);
});

test('one new command can scaffold several languages under one article identity', async () => {
  const root = await publication();
  const output = collector();

  const created = await createPost({
    terminal: output.terminal,
    options: supplied(['A multilingual idea'], {
      languages: 'en,ta,fr', today: '2026-08-30'
    }),
    cwd: root,
    now: () => 1788048000000
  });

  assert.equal(created.files.length, 3);
  const directory = path.join(root, 'content', 'posts', 'a-multilingual-idea');
  assert.deepEqual((await readdir(directory)).sort(),
    ['index.en.md', 'index.fr.md', 'index.ta.md', 'media']);
  const metadata = await Promise.all(['en', 'ta', 'fr']
    .map((language) => frontmatter(path.join(directory, `index.${language}.md`))));
  assert.equal(new Set(metadata.map((entry) => entry.id)).size, 1);
  assert.deepEqual(metadata.map((entry) => entry.language), ['en', 'ta', 'fr']);
  assert.match(output.said('note').join('\n'), /localize each title and body/i);
});

test('one explicit translation target can receive several missing languages at once', async () => {
  const root = await publication();
  const source = await createPost({
    terminal: collector().terminal,
    options: supplied(['Existing article'], { today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000
  });

  const translated = await createPost({
    terminal: collector().terminal,
    options: supplied(['Working translation title'], {
      languages: 'ta,fr', 'translation-of': 'existing-article', today: '2026-08-30'
    }),
    cwd: root,
    now: () => 1788048001000
  });

  assert.deepEqual(translated.files.map((file) => path.basename(file)),
    ['index.ta.md', 'index.fr.md']);
  const ids = await Promise.all([source.file, ...translated.files]
    .map(async (file) => (await frontmatter(file)).id));
  assert.equal(new Set(ids).size, 1);
});

test('translation targets fail before writing and list the available post slugs', async () => {
  const root = await publication();
  await createPost({
    terminal: collector().terminal,
    options: supplied(['Existing work'], { today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000
  });

  await assert.rejects(createPost({
    terminal: collector().terminal,
    options: supplied(['Missing translation'], {
      language: 'ta', 'translation-of': 'not-there', today: '2026-08-30'
    }),
    cwd: root,
    now: () => 1788048001000
  }), /No post uses slug not-there\. Available posts: existing-work/);

  await assert.rejects(readFile(
    path.join(root, 'content', 'posts', 'not-there', 'index.ta.md'), 'utf8'),
  { code: 'ENOENT' });
});

test('existing variants are kept byte-for-byte while missing requested languages are added', async () => {
  const root = await publication();
  const first = await createPost({
    terminal: collector().terminal,
    options: supplied(['Shared work'], { language: 'en', today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000
  });
  const before = await readFile(first.file, 'utf8');
  const output = collector();

  const created = await createPost({
    terminal: output.terminal,
    options: supplied(['Shared work'], { languages: 'en,ta', today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048001000
  });

  assert.deepEqual(created.files.map((file) => path.basename(file)), ['index.ta.md']);
  assert.equal(await readFile(first.file, 'utf8'), before);
  assert.match(output.said('note').join('\n'), /English already exists.*left unchanged/i);
  assert.equal((await frontmatter(created.files[0])).id, (await frontmatter(first.file)).id);
});

test('language options are unambiguous and a translation never guesses its target language', async () => {
  const root = await publication();
  await createPost({
    terminal: collector().terminal,
    options: supplied(['Source'], { today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000
  });

  await assert.rejects(createPost({
    terminal: collector().terminal,
    options: supplied(['Ambiguous'], {
      language: 'en', languages: 'en,ta', today: '2026-08-30'
    }),
    cwd: root
  }), /Use either --language or --languages, not both/);
  await assert.rejects(createPost({
    terminal: collector().terminal,
    options: supplied(['Translation'], {
      'translation-of': 'source', today: '2026-08-30'
    }),
    cwd: root
  }), /A translation needs --language <tag> or --languages <tag,tag>/);
  await assert.rejects(createPost({
    terminal: collector().terminal,
    options: supplied(['Duplicate'], { languages: 'en,EN', today: '2026-08-30' }),
    cwd: root
  }), /Language en was requested more than once/);
  await assert.rejects(createPost({
    terminal: collector().terminal,
    options: supplied(['Empty'], { languages: 'en,,ta', today: '2026-08-30' }),
    cwd: root
  }), /--languages needs comma-separated language tags/);
});

test('an interactive translation asks only for its missing language and can seed the source title', async () => {
  const root = await publication();
  const source = await createPost({
    terminal: collector().terminal,
    options: supplied(['Source title'], { today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000
  });
  const output = collector({ interactive: true, answers: ['ta'] });

  const translated = await createPost({
    terminal: output.terminal,
    options: supplied([], { 'translation-of': 'source-title', today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048001000
  });

  assert.deepEqual(output.said('ask'), ['What language are you adding? (for example ta or fr)']);
  assert.equal((await frontmatter(translated.file)).title, 'Source title');
  assert.equal((await frontmatter(translated.file)).id, (await frontmatter(source.file)).id);
  assert.match(output.said('note').join('\n'), /copied the existing title.*localize its title and body/i);
});

test('canonical duplicate language variants block translation before writing', async () => {
  const root = await publication();
  const source = await createPost({
    terminal: collector().terminal,
    options: supplied(['Source'], { language: 'he', today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000
  });
  const duplicate = (await readFile(source.file, 'utf8')).replace('language: he', 'language: iw');
  await writeFile(
    path.join(path.dirname(source.file), 'index.iw.md'),
    duplicate
  );

  await assert.rejects(createPost({
    terminal: collector().terminal,
    options: supplied(['Traduction'], {
      language: 'fr', 'translation-of': 'source', today: '2026-08-30'
    }),
    cwd: root
  }), /more than one variant for language he/);
  await assert.rejects(readFile(
    path.join(root, 'content', 'posts', 'source', 'index.fr.md'), 'utf8'),
  { code: 'ENOENT' });
});

test('a conflicting existing article identity blocks every requested translation before writing', async () => {
  const root = await publication();
  await createPost({
    terminal: collector().terminal,
    options: supplied(['Conflicted'], { languages: 'en,fr', today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000
  });
  const french = path.join(root, 'content', 'posts', 'conflicted', 'index.fr.md');
  const original = await readFile(french, 'utf8');
  await writeFile(french, original.replace(
    (await frontmatter(french)).id,
    createContentId(1788048001000)
  ));

  await assert.rejects(createPost({
    terminal: collector().terminal,
    options: supplied(['Tamil'], {
      language: 'ta', 'translation-of': 'conflicted', today: '2026-08-30'
    }),
    cwd: root
  }), /variants with conflicting article ids/);
  await assert.rejects(readFile(
    path.join(root, 'content', 'posts', 'conflicted', 'index.ta.md'), 'utf8'),
  { code: 'ENOENT' });
});

test('a failed bulk write removes every variant created by that invocation', async () => {
  const root = await publication();
  let writes = 0;

  await assert.rejects(createPost({
    terminal: collector().terminal,
    options: supplied(['Atomic work'], { languages: 'en,ta', today: '2026-08-30' }),
    cwd: root,
    now: () => 1788048000000,
    write: async (...args) => {
      writes += 1;
      if (writes === 2) throw new Error('simulated second write failure');
      return writeFile(...args);
    }
  }), /simulated second write failure/);

  assert.deepEqual(await readdir(path.join(root, 'content', 'posts', 'atomic-work')), ['media']);
});
