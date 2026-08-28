import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { galaApi } from '../api/gala.js';
import { galaCredential } from '../auth/gala.js';
import { UsageError } from '../cli/args.js';
import { createGit } from '../git.js';
import { readPublication } from '../publication.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MODES = new Map([
  ['off', 'OFF'], ['presentation-only', 'PRESENTATION_ONLY'], ['manual', 'MANUAL'],
  ['assisted', 'ASSISTED'],
]);
const POLICIES = new Map([['nofollow', 'NOFOLLOW'], ['follow', 'FOLLOW']]);

export async function prism({ terminal, options, cwd = process.cwd() }) {
  const root = path.resolve(options.value('root') ?? cwd);
  const publication = await readPublication(root);
  if (!publication || !ULID.test(publication.siteId ?? '')) {
    throw new UsageError('Run this inside a registered Gala publication, or pass --root.');
  }
  const credential = await galaCredential({ terminal, apiBaseUrl: options.value('api-base-url') });
  const api = galaApi({ baseUrl: credential.apiBaseUrl, token: credential.accessToken });
  const [action = 'status', ...args] = options.positional;

  if (action === 'status') {
    requireArgs(args, 0, 'gala prism status');
    const state = await api.json(`/v1/sites/${publication.siteId}/prism`, { action: 'Prism status' });
    terminal.result(`Prism ${state.publishedMode}`);
    terminal.note(`Mode: requested ${state.requestedMode}; published ${state.publishedMode}`);
    terminal.note(`Configuration links: requested ${state.requestedConfigurationLinkPolicy}; published ${state.publishedConfigurationLinkPolicy}`);
    return state;
  }

  const inventory = await api.json(`/v1/sites/${publication.siteId}/posts`, {
    action: 'Published post inventory',
  });
  const expectedRepositoryHeadSha = inventory.headSha;

  if (action === 'mode') {
    requireArgs(args, 1, 'gala prism mode <off|presentation-only|manual|assisted>');
    const mode = MODES.get(args[0]);
    if (!mode) throw new UsageError('Prism mode must be off, presentation-only, manual, or assisted.');
    if (mode === 'OFF' || mode === 'PRESENTATION_ONLY') await confirm(terminal, options, `Change Prism mode to ${args[0]}?`);
    const result = await mutate(api, `/v1/sites/${publication.siteId}/prism`, 'PUT', {
      mode, expectedRepositoryHeadSha,
    }, 'Prism mode');
    return settleMutation(api, terminal, publication, result);
  }

  if (action === 'link-policy') {
    const [scope, target, value] = args;
    if (scope === 'site') {
      requireArgs(args, 2, 'gala prism link-policy site <nofollow|follow>');
      const policy = policyValue(target);
      const result = await mutate(api, `/v1/sites/${publication.siteId}/prism`, 'PUT', {
        configurationLinkPolicy: policy, expectedRepositoryHeadSha,
      }, 'Prism link policy');
      return settleMutation(api, terminal, publication, result);
    }
    if (scope === 'work') {
      requireArgs(args, 3, 'gala prism link-policy work <slug> <inherit|nofollow|follow>');
      const post = resolvePost(inventory, target, options.value('language'), publication.defaultLanguage);
      if (value === 'inherit') {
        const result = await mutate(api,
          `/v1/sites/${publication.siteId}/articles/${post.articleId}/prism?fields=configurationLinkPolicy`,
          'DELETE', undefined, 'Prism work link policy', {
            'x-expected-repository-head': expectedRepositoryHeadSha,
          });
        return settleMutation(api, terminal, publication, result);
      }
      const result = await mutate(api,
        `/v1/sites/${publication.siteId}/articles/${post.articleId}/prism`, 'PUT', {
          configurationLinkPolicy: policyValue(value), expectedRepositoryHeadSha,
        }, 'Prism work link policy');
      return settleMutation(api, terminal, publication, result);
    }
    throw new UsageError('Use: gala prism link-policy site <nofollow|follow> or work <slug> <inherit|nofollow|follow>');
  }

  if (action === 'list') {
    requireArgs(args, 1, 'gala prism list <slug> [--language en]');
    const post = resolvePost(inventory, args[0], options.value('language'), publication.defaultLanguage);
    const result = await configurations(api, publication.siteId, post);
    terminal.result(`${result.configurations.length} configuration${result.configurations.length === 1 ? '' : 's'}`);
    for (const item of result.configurations) {
      terminal.note(`${item.configurationId}  ${item.depth}/${item.intent}/${item.modality}  ${item.lifecycle}/${item.deliveryState}`);
    }
    return result;
  }

  if (action === 'create') {
    requireArgs(args, 1, 'gala prism create <slug> --language en --depth brief --intent orientation');
    const post = resolvePost(inventory, args[0], options.value('language'), publication.defaultLanguage);
    const current = await configurations(api, publication.siteId, post);
    const result = await mutate(api,
      `/v1/sites/${publication.siteId}/articles/${post.articleId}/configurations`, 'POST', {
        language: post.language,
        depth: enumValue(options.value('depth') ?? 'brief', ['signal', 'brief', 'standard', 'complete', 'methods-references'], 'depth'),
        intent: enumValue(options.value('intent') ?? 'orientation', ['orientation', 'story', 'proof', 'practice'], 'intent'),
        modality: enumValue(options.value('modality') ?? 'text', ['text'], 'modality'),
        expectedSourceContentHash: current.sourceRevisionHash,
        hashContract: current.hashContract,
      }, 'Create Prism configuration');
    terminal.result(result.configurationId);
    return result;
  }

  if (!['edit', 'generate', 'submit', 'approve', 'reject', 'revoke'].includes(action)) {
    throw new UsageError('Unknown Prism action. Run gala prism --help.');
  }

  const configurationId = args[0];
  if (!ULID.test(configurationId ?? '')) throw new UsageError(`${action} needs a configuration ID.`);
  const resolved = await findConfiguration(api, publication, inventory, configurationId,
    options.value('language'));
  const { post, collection, configuration } = resolved;
  const base = `/v1/sites/${publication.siteId}/articles/${post.articleId}/configurations/${configurationId}`;

  if (action === 'edit') {
    requireArgs(args, 1, 'gala prism edit <configuration-id> --file proposal.md');
    const filename = options.value('file');
    if (!filename) throw new UsageError('Prism edit needs --file proposal.md.');
    const markdown = await readFile(path.resolve(root, filename), 'utf8');
    const result = await mutate(api, `${base}/revisions`, 'POST', {
      markdown, expectedSourceContentHash: collection.sourceRevisionHash,
      hashContract: collection.hashContract,
    }, 'Save Prism revision');
    terminal.result(result.revisionId);
    return result;
  }

  if (action === 'generate') {
    requireArgs(args, 1, 'gala prism generate <configuration-id>');
    const result = await mutate(api, `${base}/generation-jobs`, 'POST', {
      expectedSourceContentHash: collection.sourceRevisionHash,
      hashContract: collection.hashContract,
    }, 'Generate Prism proposal');
    return settleGeneration(api, terminal, publication.siteId, post.articleId,
      configurationId, result);
  }

  const revisionId = args[1] ?? configuration.workingRevision?.revisionId;
  if (action !== 'revoke' && !ULID.test(revisionId ?? '')) {
    throw new UsageError(`${action} needs a revision ID when there is no working revision.`);
  }
  if (action === 'submit') {
    if (args.length > 2) throw new UsageError('Use: gala prism submit <configuration-id> [revision-id]');
    if (revisionId !== configuration.workingRevision?.revisionId) {
      throw new UsageError('Only the current working revision can be submitted. Refresh the configuration and try again.');
    }
    const warnings = configuration.workingRevision.literalFindings
      ?.filter((item) => item.severity === 'WARNING') ?? [];
    for (const warning of warnings) terminal.note(`Warning ${warning.id}: ${warning.message}`);
    if (warnings.length > 0) {
      await confirm(terminal, options, `Acknowledge all ${warnings.length} listed warning${warnings.length === 1 ? '' : 's'}?`);
    }
    const result = await mutate(api, `${base}/submit`, 'POST', expectation(collection, {
      revisionId, acknowledgedWarningIds: warnings.map((warning) => warning.id),
    }), 'Submit Prism revision');
    terminal.result(`${result.revisionId} ${result.reviewState}`);
    return result;
  }

  const reason = options.value('reason');
  if (action === 'approve') {
    if (args.length > 2) throw new UsageError('Use: gala prism approve <configuration-id> [revision-id] [--yes]');
    if (revisionId !== configuration.workingRevision?.revisionId) {
      throw new UsageError('Only the current working revision can be approved. Refresh the configuration and try again.');
    }
    const changed = await createGit({ root }).run(
      ['status', '--porcelain', '--', `content/posts/${post.slug}`], { capture: true });
    if (changed) throw new UsageError('The canonical post has uncommitted edits. Publish or revert them before approval.');
    const warnings = configuration.workingRevision?.literalFindings
      ?.filter((item) => item.severity === 'WARNING').map((item) => item.id) ?? [];
    for (const warning of configuration.workingRevision?.literalFindings
      ?.filter((item) => item.severity === 'WARNING') ?? []) {
      terminal.note(`Warning ${warning.id}: ${warning.message}`);
    }
    if (warnings.length > 0) {
      await confirm(terminal, options, `Acknowledge all ${warnings.length} listed warning${warnings.length === 1 ? '' : 's'}?`);
    }
    await confirm(terminal, options, 'Approve this revision and publish it?');
    const result = await mutate(api, `${base}/approve`, 'POST', expectation(collection, {
      revisionId, expectedRepositoryHeadSha, acknowledgedWarningIds: warnings,
    }), 'Approve Prism revision');
    return settleMutation(api, terminal, publication, result);
  }
  if (!reason) throw new UsageError(`Prism ${action} needs --reason.`);
  await confirm(terminal, options, `${action === 'reject' ? 'Reject this revision' : 'Revoke this configuration'}?`);
  const suffix = action === 'reject' ? '/reject' : '/revoke';
  const body = action === 'reject'
    ? expectation(collection, { revisionId, reason })
    : expectation(collection, { expectedRepositoryHeadSha, reason });
  const result = await mutate(api, `${base}${suffix}`, 'POST', body, `Prism ${action}`);
  if (result.materialization) return settleMutation(api, terminal, publication, result);
  terminal.result(result.reviewState ?? action);
  return result;
}

function requireArgs(args, count, usage) {
  if (args.length !== count) throw new UsageError(`Use: ${usage}`);
}

function resolvePost(inventory, slug, requestedLanguage, defaultLanguage) {
  const variants = inventory.posts.filter((post) => post.slug === slug);
  const post = variants.find((item) => item.language === requestedLanguage)
    ?? variants.find((item) => item.language === defaultLanguage)
    ?? variants[0];
  if (!post) throw new UsageError(`No published work uses the slug ${slug}.`);
  if (!post.articleId) throw new UsageError('Publish this work once before creating configurations.');
  return post;
}

async function findConfiguration(api, publication, inventory, id, language) {
  for (const post of inventory.posts.filter((item) => item.articleId
    && (!language || item.language === language))) {
    const collection = await configurations(api, publication.siteId, post);
    const configuration = collection.configurations.find((item) => item.configurationId === id);
    if (configuration) return { post, collection, configuration };
  }
  throw new UsageError(`Configuration ${id} is not part of this publication.`);
}

function configurations(api, siteId, post) {
  return api.json(`/v1/sites/${siteId}/articles/${post.articleId}/configurations?language=${encodeURIComponent(post.language)}`, {
    action: 'Prism configurations',
  });
}

function mutate(api, path, method, body, action, extraHeaders = {}) {
  return api.json(path, {
    action, method,
    headers: {
      'content-type': 'application/json', 'idempotency-key': crypto.randomUUID(), ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function expectation(collection, extra) {
  return {
    ...extra,
    expectedSourceContentHash: collection.sourceRevisionHash,
    hashContract: collection.hashContract,
  };
}

function policyValue(value) {
  const policy = POLICIES.get(value);
  if (!policy) throw new UsageError('Link policy must be nofollow or follow.');
  return policy;
}

function enumValue(value, allowed, name) {
  if (!allowed.includes(value)) throw new UsageError(`${name} must be one of: ${allowed.join(', ')}.`);
  return value.replaceAll('-', '_').toUpperCase();
}

async function confirm(terminal, options, question) {
  if (options.on('yes')) return;
  const answer = await terminal.ask(`${question} Type yes to continue.`);
  if (answer.toLowerCase() !== 'yes') throw new UsageError('Cancelled.');
}

function showMutation(terminal, result) {
  terminal.result(`Queued ${result.materialization?.materializationId ?? result.materializationId}`);
  if (result.settings?.requestedEffectiveMode) {
    terminal.note(`Effective when published: ${result.settings.requestedEffectiveMode} / ${result.settings.requestedEffectiveConfigurationLinkPolicy}`);
  } else if (result.settings) {
    terminal.note(`Requested: ${result.settings.requestedMode} / ${result.settings.requestedConfigurationLinkPolicy}`);
  }
}

async function settleMutation(api, terminal, publication, result) {
  showMutation(terminal, result);
  const initial = result.materialization;
  if (!initial?.materializationId) return result;

  let state = initial;
  const deadline = Date.now() + 31 * 60_000;
  while (!['COMMITTED', 'FAILED'].includes(state.status) && Date.now() < deadline) {
    await delay(state.status === 'RETRY_WAIT' ? 10_000 : 3_000);
    state = await api.json(
      `/v1/sites/${publication.siteId}/prism/materializations/${initial.materializationId}`,
      { action: 'Prism repository materialization' },
    );
    terminal.note(`Repository: ${state.status} (attempt ${state.attemptCount})`);
  }
  if (state.status === 'FAILED') {
    throw new UsageError(`Repository update failed (${state.errorCode ?? 'unknown error'}). Run the command again after correcting the cause.`);
  }
  if (state.status !== 'COMMITTED') {
    throw new UsageError('Repository update did not finish before the 31-minute tracking deadline. Check gala prism status before retrying.');
  }
  if (!state.publicationAttemptSha) {
    terminal.result('Repository updated. No publication attempt was returned.');
    return { ...result, materialization: state };
  }

  terminal.note(`Repository committed at ${state.commitSha ?? state.publicationAttemptSha}. Verifying publication.`);
  const publicationState = await waitForPublication(api, terminal, publication.siteId,
    state.publicationAttemptSha, deadline);
  if (publicationState.status === 'FAILED') {
    throw new UsageError(`Publication failed (${publicationState.errors?.[0]?.message ?? 'unknown error'}).`);
  }
  if (publicationState.status !== 'PUBLISHED') {
    throw new UsageError('Publication did not finish before the 31-minute tracking deadline.');
  }
  const live = publicationUrl(publication);
  terminal.result(live ? `Published at ${live}` : 'Published.');
  return { ...result, materialization: state, publicationAttempt: publicationState };
}

async function waitForPublication(api, terminal, siteId, commitSha, deadline) {
  let state;
  do {
    state = await api.json(`/v1/sites/${siteId}/publication-attempts/${commitSha}`, {
      action: 'Prism publication attempt',
    });
    terminal.note(`Publication: ${state.status}`);
    if (['PUBLISHED', 'FAILED'].includes(state.status)) return state;
    await delay(5_000);
  } while (Date.now() < deadline);
  return state;
}

function publicationUrl(publication) {
  if (publication.url) return publication.url.replace(/\/$/, '');
  const base = publication.canonicalBaseUrl ?? publication.hosting?.canonicalBaseUrl;
  const prefix = publication.pathPrefix ?? publication.hosting?.pathPrefix ?? '';
  return base ? `${base.replace(/\/$/, '')}/${prefix.replace(/^\//, '').replace(/\/$/, '')}`.replace(/\/$/, '') : undefined;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settleGeneration(api, terminal, siteId, articleId, configurationId, initial) {
  terminal.result(`${initial.jobId} ${initial.status}`);
  let state = initial;
  const deadline = Date.now() + 31 * 60_000;
  while (!['SUCCEEDED', 'FAILED'].includes(state.status) && Date.now() < deadline) {
    await delay(3_000);
    state = await api.json(
      `/v1/sites/${siteId}/articles/${articleId}/configurations/${configurationId}/generation-jobs/${initial.jobId}`,
      { action: 'Prism generation job' },
    );
    terminal.note(`Generation: ${state.status} (attempt ${state.attemptCount})`);
  }
  if (state.status === 'FAILED') {
    throw new UsageError(`Proposal generation failed (${state.errorCode ?? 'unknown error'}).`);
  }
  if (state.status !== 'SUCCEEDED') {
    throw new UsageError('Proposal generation did not finish before the 31-minute tracking deadline.');
  }
  terminal.result(`Proposal revision ${state.revisionId} is ready for review.`);
  return state;
}
