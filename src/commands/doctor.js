import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse } from 'yaml';

import { galaApi } from '../api/gala.js';
import { accountForCommand } from '../auth/checkout-profile.js';
import { authenticatedProfile } from '../auth/profiles.js';
import { cliCommand } from '../cli/invocation.js';
import { createGit } from '../git.js';

/**
 * Answers "why is this not working" without the writer having to know where to look.
 *
 * Every check reports one of three things and never guesses between them: it is fine, it is wrong
 * and here is the fix, or it could not be determined. That third state is the one v0 kept
 * collapsing into the second - an unreachable GitHub reported as "the App is not installed" sent
 * writers to install something that was already installed, repeatedly.
 */
export async function doctor({ terminal, options, cwd = process.cwd() }) {
  const root = path.resolve(options.value('root') ?? cwd);
  const checks = [];

  let selected;
  checks.push(await checkCredential('Account profile', async () => {
    const account = await accountForCommand(options, root, { terminal });
    selected = await authenticatedProfile({ name: account, terminal });
    return ok(`${account}: Gala ${selected.metadata.gala.email} + GitHub @${selected.metadata.githubLogin}`);
  }));

  checks.push(await checkCredential('Gala sign-in', async () => {
    if (selected == null) throw new Error('account profile is unavailable');
    const gala = selected.gala;
    const accepted = await galaApi({ baseUrl: gala.apiBaseUrl, token: gala.accessToken }).accepted();
    return accepted
      ? ok(`valid until ${new Date(gala.expiresAt).toLocaleString()}`)
      : wrong('the API no longer accepts it', cliCommand('auth'));
  }));

  checks.push(await checkCredential('GitHub sign-in', async () => {
    if (selected == null) throw new Error('account profile is unavailable');
    const github = selected.github;
    return ok(github.expiresAt
      ? `valid until ${new Date(github.expiresAt).toLocaleString()}`
      : 'signed in');
  }));

  checks.push(await check('Publication folder', async () => {
    const config = path.join(root, 'site.config.yml');
    await stat(config);
    const posts = await countPosts(root);
    return ok(`${posts} post${posts === 1 ? '' : 's'}`);
  }, 'run this inside a publication, or pass --root'));

  checks.push(await check('Publishing workflow', async () => {
    const workflow = path.join(root, '.github', 'workflows', 'publish.yml');
    const source = await readFile(workflow, 'utf8');
    const siteId = /site-id:\s*([0-9A-Z]{26})/.exec(source)?.[1];
    return siteId == null
      ? wrong('no site id - this publication may not be registered', cliCommand('init'))
      : ok(siteId);
  }, 'the workflow is missing; registration writes it'));

  checks.push(...await aiReadinessChecks(root));

  checks.push(await check('Unsent work', async () => {
    const git = createGit({ root });
    const dirty = await git.run(['status', '--porcelain'], { capture: true });
    const ahead = await git.run(['rev-list', '--count', '@{upstream}..HEAD'], { capture: true, allow: [0, 128] });
    if (dirty !== '') return wrong(`${dirty.split('\n').length} file(s) not recorded`, cliCommand('publish'));
    if (ahead !== '' && ahead !== '0') return wrong(`${ahead} commit(s) not sent`, cliCommand('publish'));
    return ok('everything is on GitHub');
  }, 'this folder is not a git checkout'));

  terminal.blank();
  for (const { name, state, detail, fix } of checks) {
    if (state === 'ok') terminal.done(`${name} - ${detail}`);
    else if (state === 'wrong') terminal.fail(`${name} - ${detail}`);
    else if (state === 'advisory') terminal.step(`${name} - ${detail}`);
    else terminal.step(`${name} - could not be determined: ${detail}`);
    if (fix) terminal.note(fix);
  }

  const broken = checks.filter(({ state }) => state === 'wrong');
  if (broken.length > 0) throw new Error(`${broken.length} problem(s) found`);
  terminal.blank();
  terminal.note('Nothing looks wrong.');
}

const ok = (detail) => ({ state: 'ok', detail });
const wrong = (detail, fix) => ({ state: 'wrong', detail, fix });
const advisory = (detail, fix) => ({ state: 'advisory', detail, fix });

/** Distinguishes "this is wrong" from "I could not tell", which are different answers. */
async function check(name, run, unknownHint) {
  try {
    return { name, ...await run() };
  } catch (failure) {
    return { name, state: 'unknown', detail: failure.message, fix: unknownHint };
  }
}

/** Credentials are obtained rather than merely inspected, so doctor can also repair a sign-in. */
const checkCredential = check;

async function countPosts(root) {
  try {
    const posts = path.join(root, 'content', 'posts');
    const entries = await readdir(posts, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

const AI_RUNTIME_FILES = Object.freeze([
  'lib/ai-discovery.js',
  'lib/seo.js',
  'src/llms.11ty.js',
  'src/robots.11ty.js',
  'src/rsl.11ty.js',
  'src/article-markdown.11ty.js',
  'src/article-provenance.11ty.js',
  'src/_includes/layouts/base.njk'
]);
const AI_VALUES = Object.freeze({
  indexing: Object.freeze(['not-declared', 'allow', 'block']),
  aiSearch: Object.freeze(['not-declared', 'allow', 'block']),
  modelTraining: Object.freeze(['not-declared', 'allow', 'block']),
  reuse: Object.freeze(['not-declared', 'attribution-required', 'block']),
  commercialUse: Object.freeze(['not-declared', 'allow', 'license-required', 'block'])
});

/** Source-only AI readiness checks. They never import or execute JavaScript from the checkout. */
export async function aiReadinessChecks(root) {
  const checks = [];
  checks.push(await check('AI discovery runtime', async () => {
    const missing = [];
    for (const relative of AI_RUNTIME_FILES) {
      try {
        const metadata = await stat(path.join(root, relative));
        if (!metadata.isFile()) missing.push(relative);
      } catch {
        missing.push(relative);
      }
    }
    if (missing.length > 0) {
      return wrong(`${missing.length} managed discovery file(s) are missing`, cliCommand('upgrade'));
    }
    const base = await readFile(path.join(root, 'src/_includes/layouts/base.njk'), 'utf8');
    if (!base.includes('type="text/markdown"') || !base.includes('rel="describedby"')) {
      return wrong('Markdown or provenance discovery links are missing', cliCommand('upgrade'));
    }
    return ok('HTML, Markdown, llms.txt, robots, schema and provenance generators are present');
  }, 'run the managed-theme upgrade from a registered publication'));

  checks.push(await check('AI rights and attestations', async () => {
    const config = parse(await readFile(path.join(root, 'site.config.yml'), 'utf8'));
    let policy;
    try {
      policy = validateAiPolicy(config?.aiPublishing);
    } catch (failure) {
      return wrong(`invalid AI publishing policy: ${failure.message}`,
        'Open publication settings → AI & reuse, review the policy, and save it.');
    }
    const workflow = await readFile(path.join(root, '.github/workflows/publish.yml'), 'utf8');
    const workflowAttests = /(?:^|\n)\s*attest-build:\s*true\s*(?:\n|$)/.test(workflow);
    const identityPermission = /(?:^|\n)\s*id-token:\s*write\s*(?:\n|$)/.test(workflow);
    const attestationPermission = /(?:^|\n)\s*attestations:\s*write\s*(?:\n|$)/.test(workflow);
    if (!identityPermission || !attestationPermission) {
      return wrong('mandatory publishing workflow permissions are missing', cliCommand('upgrade'));
    }
    if (policy.attestBuilds !== workflowAttests) {
      return wrong('site policy and attestation generation setting disagree', cliCommand('upgrade'));
    }
    if (!policy.declared) {
      return ok('no rights declaration; RSL is intentionally absent');
    }
    if (policy.confirmation !== policy.digest) {
      return wrong('the selected rights policy is not confirmed',
        'Open publication settings → AI & reuse, review the exact policy, and save it.');
    }
    const canonicalBaseUrl = config?.hosting?.canonicalBaseUrl;
    const pathPrefix = config?.hosting?.pathPrefix;
    let projectSite = false;
    try {
      projectSite = typeof canonicalBaseUrl === 'string'
        && new URL(canonicalBaseUrl).hostname.toLowerCase().endsWith('.github.io')
        && typeof pathPrefix === 'string' && pathPrefix !== '/';
    } catch {
      // Site configuration validation reports malformed hosting values elsewhere.
    }
    if (projectSite) {
      return advisory(
        `confirmed rights declaration ${policy.digest.slice(0, 12)}…; `
          + 'crawler-specific robots rules are not origin-root on this GitHub project URL',
        'Connect a custom domain to make robots.txt authoritative for the publication origin. '
          + 'RSL and per-page discovery metadata are still published.'
      );
    }
    return ok(`confirmed rights declaration ${policy.digest.slice(0, 12)}…${policy.attestBuilds ? ' with build attestations' : ''}`);
  }, 'open publication settings → AI & reuse, or repair site.config.yml'));

  checks.push(await check('Answer-first articles', async () => {
    const files = await markdownFiles(path.join(root, 'content', 'posts'));
    let missingSummary = 0;
    let missingAnswer = 0;
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (!/(?:^|\n)description:\s*\S/.test(source)) missingSummary++;
      if (!/(?:^|\n)>\s*\[!ANSWER]\s*(?:\n|$)/i.test(source)) missingAnswer++;
    }
    if (missingSummary > 0 || missingAnswer > 0) {
      return advisory(`${missingSummary} missing summaries; ${missingAnswer} missing optional direct-answer sections`,
        'Add description frontmatter and use > [!ANSWER] where a concise answer helps the reader.');
    }
    return ok(`${files.length} article variant(s) include summaries and direct-answer sections`);
  }, 'article guidance could not be inspected'));
  return checks;
}

function validateAiPolicy(value) {
  const policy = value == null ? {} : value;
  if (Array.isArray(policy) || typeof policy !== 'object') {
    throw new TypeError('aiPublishing must be a mapping');
  }
  const supported = [...Object.keys(AI_VALUES), 'licenseUrl', 'confirmation', 'attestBuilds'];
  const unknown = Object.keys(policy).filter((key) => !supported.includes(key));
  if (unknown.length > 0) throw new TypeError(`Unsupported aiPublishing option: ${unknown.join(', ')}`);
  const normalized = {};
  for (const [field, allowed] of Object.entries(AI_VALUES)) {
    normalized[field] = policy[field] ?? 'not-declared';
    if (!allowed.includes(normalized[field])) {
      throw new TypeError(`Unsupported aiPublishing.${field}: ${normalized[field]}`);
    }
  }
  normalized.licenseUrl = policy.licenseUrl === 'unavailable' ? '' : (policy.licenseUrl ?? '');
  if (typeof normalized.licenseUrl !== 'string') {
    throw new TypeError('aiPublishing.licenseUrl must be a string');
  }
  normalized.licenseUrl = normalized.licenseUrl.trim();
  if (normalized.licenseUrl !== '') {
    let license;
    try { license = new URL(normalized.licenseUrl); } catch { throw new TypeError('aiPublishing.licenseUrl must be an HTTPS URL'); }
    if (license.protocol !== 'https:' || license.username || license.password || license.hash) {
      throw new TypeError('aiPublishing.licenseUrl must be credential-free HTTPS without a fragment');
    }
  }
  if (normalized.commercialUse === 'license-required' && normalized.licenseUrl === '') {
    throw new TypeError('aiPublishing.licenseUrl is required for licensed commercial use');
  }
  if (normalized.commercialUse !== 'license-required' && normalized.licenseUrl !== '') {
    throw new TypeError('aiPublishing.licenseUrl is only valid for licensed commercial use');
  }
  if (policy.attestBuilds != null && typeof policy.attestBuilds !== 'boolean') {
    throw new TypeError('aiPublishing.attestBuilds must be a boolean');
  }
  normalized.attestBuilds = policy.attestBuilds === true;
  const declared = Object.keys(AI_VALUES).some((field) => normalized[field] !== 'not-declared');
  const incomplete = Object.keys(AI_VALUES)
    .filter((field) => normalized[field] === 'not-declared');
  if (declared && incomplete.length > 0) {
    throw new TypeError(`Select all five rights choices before declaring a policy; missing: ${incomplete.join(', ')}`);
  }
  if (normalized.reuse === 'block'
      && [normalized.indexing, normalized.aiSearch, normalized.modelTraining].includes('allow')) {
    throw new TypeError('aiPublishing.reuse conflicts with an allowed automated use');
  }
  if (normalized.reuse === 'block' && normalized.commercialUse !== 'block') {
    throw new TypeError('Blocked reuse requires commercial use to be blocked');
  }
  const declaration = Object.fromEntries(Object.keys(AI_VALUES).map((field) => [field, normalized[field]]));
  declaration.licenseUrl = normalized.licenseUrl;
  const digest = createHash('sha256').update(JSON.stringify(declaration)).digest('hex');
  const confirmation = policy.confirmation === 'unavailable' ? '' : (policy.confirmation ?? '');
  if (typeof confirmation !== 'string' || (confirmation !== '' && !/^[a-f0-9]{64}$/.test(confirmation))) {
    throw new TypeError('aiPublishing.confirmation must be a lowercase SHA-256 digest');
  }
  if (!declared && confirmation !== '') {
    throw new TypeError('aiPublishing.confirmation must be absent without a rights declaration');
  }
  return { ...normalized, declared, digest, confirmation };
}

async function markdownFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(target));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(target);
  }
  return files;
}
