import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

import {
  PUBLICATION_STATE_PATH,
  readPublicationState,
  recordSuccessfulDeployment
} from '../src/publication-state.js';

const DEPLOYED_SHA = 'a'.repeat(40);

function manifest(posts) {
  return { schemaVersion: 1, evaluationDate: '2026-06-15', posts };
}

test('records first publication independently for every deployed language', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-publication-state-'));
  const state = await recordSuccessfulDeployment({
    root,
    deployedOn: '2026-06-15',
    deployedCommitSha: DEPLOYED_SHA,
    manifest: manifest([
      {
        source: 'content/posts/post/index.en.md', id: '01K00000000000000000000000',
        slug: 'post', language: 'en', publicationState: 'published'
      },
      {
        source: 'content/posts/post/index.fr.md', id: '01K00000000000000000000000',
        slug: 'post', language: 'fr', publicationState: 'published'
      },
      {
        source: 'content/posts/deleted/index.en.md', id: '01K00000000000000000000001',
        slug: 'deleted', language: 'en', publicationState: 'tombstoned'
      }
    ])
  });
  assert.deepEqual(state, {
    schemaVersion: 1,
    deployedCommitSha: DEPLOYED_SHA,
    posts: [{
      id: '01K00000000000000000000000',
      slug: 'post',
      languages: {
        en: { firstPublishedOn: '2026-06-15' },
        fr: { firstPublishedOn: '2026-06-15' }
      }
    }]
  });
  assert.deepEqual(parse(await readFile(path.join(root, PUBLICATION_STATE_PATH), 'utf8')), state);
});

test('retains first publication and historical identities across later successful deploys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-publication-state-'));
  await recordSuccessfulDeployment({
    root,
    deployedOn: '2026-06-15',
    deployedCommitSha: DEPLOYED_SHA,
    manifest: manifest([{
      source: 'content/posts/post/index.en.md', id: '01K00000000000000000000000',
      slug: 'post', language: 'en', publicationState: 'published'
    }])
  });
  const state = await recordSuccessfulDeployment({
    root,
    deployedOn: '2026-07-01',
    deployedCommitSha: 'b'.repeat(40),
    manifest: manifest([{
      source: 'content/posts/post/index.fr.md', id: '01K00000000000000000000000',
      slug: 'post', language: 'fr', publicationState: 'published'
    }])
  });
  assert.deepEqual(state.posts[0], {
    id: '01K00000000000000000000000',
    slug: 'post',
    languages: {
      en: { firstPublishedOn: '2026-06-15' },
      fr: { firstPublishedOn: '2026-07-01' }
    }
  });
});

test('rejects tampered state and published manifest entries without stable IDs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-publication-state-'));
  await writeFile(path.join(root, 'state.yml'), 'not used');
  await assert.rejects(() => recordSuccessfulDeployment({
    root,
    deployedOn: '2026-06-15',
    deployedCommitSha: DEPLOYED_SHA,
    manifest: manifest([{
      source: 'content/posts/post/index.en.md', id: null,
      slug: 'post', language: 'en', publicationState: 'published'
    }])
  }), /missing a stable ULID/);
  await assert.rejects(() => readPublicationState(root), { code: 'ENOENT' });
});

test('rejects an invalid deployment date even when no new post would consume it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'gala-publication-state-'));
  await assert.rejects(() => recordSuccessfulDeployment({
    root,
    deployedOn: '2026-02-30',
    deployedCommitSha: DEPLOYED_SHA,
    manifest: manifest([])
  }), /deployedOn must be a valid YYYY-MM-DD date/);
});
