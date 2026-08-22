import { createHash } from 'node:crypto';
import path from 'node:path';

import { galaApi } from '../api/gala.js';
import { githubApi } from '../api/github.js';
import { galaCredential } from '../auth/gala.js';
import { githubCredential } from '../auth/github.js';
import { cloneRepository, createGit } from '../git.js';
import { UsageError } from '../cli/args.js';

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
 *     entire content was rewriting one line and stripping comments — and a second workflow run that
 *     collided with the first one's deployment record and failed.
 *   - **GitHub** turns on Pages by itself once publishing creates a `gh-pages` branch. The CLI used
 *     to poll ten minutes for a run it had caused, then call an API that changed nothing.
 *
 * What is left is genuinely the CLI's: asking what to call it, cloning, and reporting the address.
 */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function init({ terminal, options, cwd = process.cwd() }) {
  const explicitName = options.value('name');
  const here = options.on('here');
  const target = here ? cwd : undefined;

  const gala = await galaCredential({ terminal, apiBaseUrl: options.value('api-base-url') });
  const github = await githubCredential({ terminal });

  const name = await publicationName({ terminal, explicitName, here, cwd });
  const directory = path.resolve(cwd, target ?? name);
  await refuseOccupied(directory, here);

  const api = galaApi({ baseUrl: gala.apiBaseUrl, token: gala.accessToken });
  const capability = await api.githubCapability(github.accessToken);

  terminal.step(`Creating ${name}`);
  const created = await createPublication({ terminal, api, capability, name, github });

  terminal.step('Waiting for GitHub to copy the template');
  await waitForContent(githubApi(github.accessToken), created.owner, created.name);

  terminal.step('Cloning');
  await cloneRepository({
    url: `https://github.com/${created.owner}/${created.name}.git`,
    target: directory,
    token: github.accessToken
  });

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

  terminal.done(`Created ${created.owner}/${created.name}`);
  terminal.result(publicationUrl(registration, created));
  terminal.note(path.relative(cwd, directory) || '.');
  terminal.blank();
  terminal.note('gala new "Your first post"');

  return { owner: created.owner, name: created.name, siteId: registration.siteId, root: directory };
}

/**
 * Creation is a conversation, not a single call.
 *
 * `NEEDS_SHARING` means the repository exists with the right content and the App installation
 * simply cannot see it — an installation scoped to selected repositories, which is the right way to
 * have it. That is one grant away from working, and GitHub offers no API to do it on the writer's
 * behalf: adding a repository to an installation is documented as classic-PAT-only. So it is asked
 * for, with a link to the one page that grants it.
 */
async function createPublication({ terminal, api, capability, name, github }) {
  let created = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await api.createPublication({ capability, name });
    if (result?.status === 'READY') {
      if (typeof result.owner !== 'string' || typeof result.name !== 'string') {
        throw new Error('Gala created the publication but did not say where');
      }
      return result;
    }

    // Once the repository exists a further refusal reports UNSUPPORTED rather than NEEDS_SHARING:
    // the same situation under a different name.
    const shareable = result?.status === 'NEEDS_SHARING' || created;
    if (!shareable) {
      throw new Error(
        `Gala could not create the publication (${result?.outcome ?? result?.status}). `
        + 'Install the Gala GitHub App at https://github.com/apps/gala67-app and try again.'
      );
    }
    created = true;

    const owner = result?.owner ?? '';
    terminal.blank();
    terminal.step(`${owner}/${result?.name ?? name} exists, but Gala cannot reach it yet`);
    terminal.note('its installation covers only selected repositories — add this one');
    terminal.openUrl(installationUrl(result?.installationId, owner, await viewerOf(github)));
    if (!await terminal.waitForEnter('Once Gala can access it')) {
      throw new Error(`Add ${owner}/${result?.name ?? name} to the Gala GitHub App, then run this again.`);
    }
  }
  throw new Error(`Gala still cannot reach the repository for ${name}.`);
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
 * gives an empty checkout and a missing site.config.yml — a confusing error about a file the
 * template certainly contains.
 */
async function waitForContent(github, owner, name, { attempts = 30, intervalMs = 1000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await github.hasContent(owner, name)) return;
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
  throw new Error(`${owner}/${name} was created but is still empty. Try again in a moment.`);
}

async function publicationName({ terminal, explicitName, here, cwd }) {
  const proposed = explicitName ?? (here ? path.basename(path.resolve(cwd)) : undefined);
  const answer = proposed ?? await terminal.ask('What should this publication be called?');
  const name = slugify(answer);
  if (name == null) {
    throw new UsageError(`"${answer}" cannot be a repository name — use letters, numbers and hyphens`);
  }
  return name;
}

export function slugify(value) {
  if (typeof value !== 'string') return null;
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return NAME.test(slug) ? slug : null;
}

async function refuseOccupied(directory, here) {
  const { readdir } = await import('node:fs/promises');
  let entries;
  try {
    entries = await readdir(directory);
  } catch (missing) {
    if (missing?.code === 'ENOENT') return;
    throw missing;
  }
  if (entries.length === 0) return;
  throw new UsageError(here
    ? 'This folder is not empty. Run it in an empty folder, or without --here.'
    : `${path.basename(directory)} already exists and is not empty.`);
}

function publicationUrl(registration, created) {
  const base = registration?.canonicalBaseUrl ?? `https://${created.owner.toLowerCase()}.github.io`;
  const prefix = registration?.pathPrefix ?? `/${created.name}`;
  return `${base}${prefix === '/' ? '' : prefix}/`;
}

function idempotencyKey(owner, name) {
  return `init-${createHash('sha256').update(`${owner.toLowerCase()}/${name.toLowerCase()}`).digest('hex')}`;
}
