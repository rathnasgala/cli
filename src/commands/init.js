import { createHash } from 'node:crypto';
import path from 'node:path';

import { galaApi } from '../api/gala.js';
import { githubApi } from '../api/github.js';
import { galaCredential } from '../auth/gala.js';
import { githubCredential } from '../auth/github.js';
import { cloneRepository, createGit, populateEmptyRepository } from '../git.js';
import { UsageError } from '../cli/args.js';
import { CLI_INVOCATION, shellArgument } from '../cli/invocation.js';
import { customDomain } from '../domain.js';

/**
 * Creates a publication and leaves a working checkout behind.
 *
 * The shape of this command is the lesson of v0. Everything it used to do itself now belongs to
 * whoever can do it correctly:
 *
 *   - The **server** creates the repository, because it is the same call the browser editor makes:
 *     it falls back from template to empty-and-seed, waits for the App installation to actually
 *     reach the result, and reports the installation id. The CLI's own version had none of that,
 *     which is why repositories it created never appeared in the web UI.
 *   - The **server** writes `site.config.yml` and the publish workflow during registration. The CLI
 *     used to write its own versions afterwards and commit them, producing a second commit whose
 *     entire content was rewriting one line and stripping comments - and a second workflow run that
 *     collided with the first one's deployment record and failed.
 *   - **GitHub** turns on Pages by itself once publishing creates a `gh-pages` branch. The CLI used
 *     to poll ten minutes for a run it had caused, then call an API that changed nothing.
 *
 * What is left is genuinely the CLI's: asking what to call it, cloning, and explaining the next
 * steps without presenting a deployment as live before GitHub has finished it.
 */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_APP_INSTALLATION_URL = 'https://github.com/apps/gala67-app/installations/new';

export async function init({ terminal, options, cwd = process.cwd() }) {
  const explicitName = options.value('name');
  if (options.positional.length > 1) {
    throw new UsageError('init accepts at most one destination directory');
  }
  const directory = path.resolve(cwd, options.positional[0] ?? '.');
  const requestedDomain = options.value('domain');
  const checkedDomain = requestedDomain == null ? null : customDomain(requestedDomain);
  if (checkedDomain?.error) throw new UsageError(checkedDomain.error);

  const destination = await inspectDestination(directory);

  const gala = await galaCredential({ terminal, apiBaseUrl: options.value('api-base-url') });
  const github = await githubCredential({ terminal });

  const name = await publicationName({ terminal, explicitName, directory });

  const api = galaApi({ baseUrl: gala.apiBaseUrl, token: gala.accessToken });
  const capability = await api.githubCapability(github.accessToken);
  const installation = await publicationAccount({ terminal, api, capability });

  terminal.step(`Creating ${name}`);
  const created = await createPublication({
    terminal, api, capability, name, github, installationId: installation.installationId
  });

  terminal.step('Waiting for GitHub to copy the template');
  await waitForContent(githubApi(github.accessToken), created.owner, created.name);

  terminal.step('Cloning');
  const checkout = {
    url: `https://github.com/${created.owner}/${created.name}.git`,
    target: directory,
    token: github.accessToken
  };
  if (destination === 'empty-git') await populateEmptyRepository(checkout);
  else await cloneRepository(checkout);

  terminal.step('Registering the publication');
  const git = createGit({ root: directory, token: github.accessToken });
  const registration = await api.registerSite({
    capability,
    idempotencyKey: idempotencyKey(created.owner, created.name),
    repositoryOwner: created.owner,
    repositoryName: created.name,
    topology: 'PROVIDER_DEFAULT',
    canonicalBaseUrl: `https://${created.owner.toLowerCase()}.github.io`
  });

  await githubApi(github.accessToken)
    .setVariable(created.owner, created.name, 'GALA_API_BASE_URL', api.baseUrl);

  // Registration wrote the managed files into the repository; bring them into the checkout so the
  // writer's copy is the publication as it actually exists.
  await git.takeRemote();

  let domainChange;
  if (checkedDomain?.host) {
    terminal.step(`Reserving ${checkedDomain.host}`);
    try {
      domainChange = await api.prepareTopologyChange(registration.siteId, {
        canonicalBaseUrl: `https://${checkedDomain.host}`,
        pathPrefix: '/'
      });
    } catch (failure) {
      throw new Error(
        `${created.owner}/${created.name} was created, but ${checkedDomain.host} was not reserved: `
          + `${failure instanceof Error ? failure.message : 'unknown error'}`
      );
    }
  }

  reportCreatedPublication({
    terminal,
    owner: created.owner,
    name: created.name,
    directoryLabel: path.relative(cwd, directory) || '.',
    hasDomainChange: domainChange != null
  });

  return { owner: created.owner, name: created.name, siteId: registration.siteId, root: directory };
}

/**
 * Creation is a conversation, not a single call.
 *
 * `NEEDS_SHARING` means the repository exists with the right content and the App installation
 * simply cannot see it - an installation scoped to selected repositories, which is the right way to
 * have it. That is one grant away from working, and GitHub offers no API to do it on the writer's
 * behalf: adding a repository to an installation is documented as classic-PAT-only. So it is asked
 * for, with a link to the one page that grants it.
 */
async function createPublication({ terminal, api, capability, name, github, installationId }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await api.createPublication({ capability, name, installationId });
    if (result?.status === 'READY') {
      if (typeof result.owner !== 'string' || typeof result.name !== 'string') {
        throw new Error('Gala created the publication but did not say where');
      }
      return result;
    }

    if (result?.status === 'SETUP_PENDING') {
      terminal.note(`${result.owner ?? ''}/${result.name ?? name} exists; GitHub is still copying it`);
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
      continue;
    }

    if (result?.status !== 'NEEDS_SHARING') {
      throw new Error(
        `Gala could not create the publication (${result?.outcome ?? result?.status}). `
        + `Continue at ${result?.recoveryUrl ?? GITHUB_APP_INSTALLATION_URL} `
        + 'and try again.'
      );
    }

    const owner = result?.owner ?? '';
    terminal.blank();
    terminal.step(`${owner}/${result?.name ?? name} exists, but Gala cannot reach it yet`);
    terminal.note('its installation covers only selected repositories - add this one');
    terminal.openUrl(result?.recoveryUrl
      ?? installationUrl(result?.installationId, owner, await viewerOf(github)));
    if (!await terminal.waitForEnter('Once Gala can access it')) {
      throw new Error(`Add ${owner}/${result?.name ?? name} to the Gala GitHub App, then run this again.`);
    }
  }
  throw new Error(`Gala still cannot reach the repository for ${name}.`);
}

export async function publicationAccount({
  terminal,
  api,
  capability,
  pause = (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); })
}) {
  let state = await api.githubInstallationAccounts({ capability });
  let accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  if (accounts.length === 0) {
    const url = state?.installationUrl ?? GITHUB_APP_INSTALLATION_URL;
    terminal.blank();
    terminal.step('Connect Gala to a GitHub account');
    terminal.note('GitHub will ask which account and repositories Gala may use');
    terminal.openUrl(url);
    if (!await terminal.waitForEnter('Once the Gala GitHub App is installed')) {
      throw new Error(`Install or request the Gala GitHub App at ${url}, then run this again.`);
    }

    for (let attempt = 0; attempt < 5 && accounts.length === 0; attempt += 1) {
      if (attempt > 0) await pause(1000);
      state = await api.githubInstallationAccounts({ capability });
      accounts = Array.isArray(state?.accounts) ? state.accounts : [];
    }
    if (accounts.length === 0) {
      throw new Error(`Gala still cannot see a GitHub App installation. Check ${url}, then run this again.`);
    }
  }
  const personal = accounts.find((account) => account?.organization === false);
  if (personal) return personal;
  if (accounts.length === 1) return accounts[0];

  const choices = accounts.map((account) => account.login).join(', ');
  const selected = (await terminal.ask(`Which GitHub account should own it? (${choices})`)).trim();
  const account = accounts.find((candidate) =>
    candidate.login.toLowerCase() === selected.toLowerCase());
  if (!account) throw new UsageError(`Choose one of these GitHub accounts: ${choices}`);
  return account;
}

let viewerCache;
async function viewerOf(github) {
  viewerCache ??= await githubApi(github.accessToken).viewer();
  return viewerCache;
}

/** User and organisation installations live on different settings paths. */
export function installationUrl(installationId, owner, selfLogin) {
  const id = Number(installationId);
  if (!Number.isSafeInteger(id) || id <= 0) return 'https://github.com/settings/installations';
  return owner && selfLogin && owner.toLowerCase() !== selfLogin.toLowerCase()
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

/**
 * GitHub answers the creation call before the template content lands. Cloning into that window
 * gives an empty checkout and a missing site.config.yml - a confusing error about a file the
 * template certainly contains.
 */
async function waitForContent(github, owner, name, { attempts = 30, intervalMs = 1000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await github.hasContent(owner, name)) return;
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
  throw new Error(`${owner}/${name} was created but is still empty. Try again in a moment.`);
}

async function publicationName({ terminal, explicitName, directory }) {
  const proposed = explicitName ?? path.basename(directory);
  const answer = proposed ?? await terminal.ask('What should this publication be called?');
  const name = slugify(answer);
  if (name == null) {
    throw new UsageError(`"${answer}" cannot be a repository name - use letters, numbers and hyphens`);
  }
  return name;
}

export function slugify(value) {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return NAME.test(slug) ? slug : null;
}

export async function inspectDestination(directory) {
  const { readFile, readdir, stat } = await import('node:fs/promises');
  let entries;
  try {
    entries = await readdir(directory);
  } catch (missing) {
    if (missing?.code === 'ENOENT') return 'missing';
    throw missing;
  }
  if (entries.length === 0) return 'empty';
  if (entries.length === 1 && entries[0] === '.git') {
    const gitDirectory = path.join(directory, '.git');
    if (!(await stat(gitDirectory)).isDirectory()) {
      throw new UsageError('The destination has a linked .git file; use a new empty directory.');
    }
    const head = (await readFile(path.join(gitDirectory, 'HEAD'), 'utf8')).trim();
    const branch = /^ref: (refs\/heads\/.+)$/.exec(head)?.[1];
    if (branch) {
      const packed = await readFile(path.join(gitDirectory, 'packed-refs'), 'utf8')
        .then((source) => source.split('\n').some((line) => line && !line.startsWith('#')),
          (failure) => failure?.code === 'ENOENT' ? false : Promise.reject(failure));
      if (!await hasReference(path.join(gitDirectory, 'refs')) && !packed) return 'empty-git';
    }
  }
  throw new UsageError('Gala needs an empty destination directory (an empty git repository is allowed).');
}

async function hasReference(directory) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(directory, { withFileTypes: true }).catch((failure) => {
    if (failure?.code === 'ENOENT') return [];
    throw failure;
  });
  for (const entry of entries) {
    if (!entry.isDirectory()) return true;
    if (await hasReference(path.join(directory, entry.name))) return true;
  }
  return false;
}

export function reportCreatedPublication({
  terminal,
  owner,
  name,
  directoryLabel,
  hasDomainChange = false
}) {
  const run = CLI_INVOCATION;
  terminal.done(`Created ${owner}/${name}`);
  terminal.note('The first deployment is running in GitHub Actions. The public site is not live yet.');
  terminal.note(`track it at https://github.com/${owner}/${name}/actions`);

  terminal.blank();
  terminal.result('Next steps');
  if (directoryLabel !== '.') terminal.note(`cd ${shellArgument(directoryLabel)}`);
  terminal.note(`${run} new "Your first post"`);
  terminal.note('creates a local Markdown draft; it does not publish');
  terminal.note(`${run} preview`);
  terminal.note('builds and serves the publication locally');
  terminal.note(`${run} publish`);
  terminal.note('checks and sends the work to GitHub');
  if (hasDomainChange) {
    terminal.note(`${run} domain check`);
    terminal.note('checks whether the custom domain is ready');
  }
  terminal.note(`${run} --help`);
  terminal.note('lists every available command');
}

function idempotencyKey(owner, name) {
  return `init-${createHash('sha256').update(`${owner.toLowerCase()}/${name.toLowerCase()}`).digest('hex')}`;
}
