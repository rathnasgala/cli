import { createHash } from 'node:crypto';
import path from 'node:path';

import { configureSite } from './configure-site.js';
import { readGalaCredential } from './gala-credential-store.js';
import { readGithubCredential } from './github-credential-store.js';
import { awaitRepositoryContent, cloneRepository } from './github-template-repository.js';
import { createPublication } from './publication-creation-client.js';
import { installRepositoryVariable } from './github-repository-variable.js';
import { provisionGithubPages } from './github-pages-provisioning.js';
import { registerSite } from './site-registration-client.js';
import { commitScaffold, syncScaffold } from './scaffold-git.js';
import {
  setRepositoryOrigin, verifyEmptyRepository, verifyRepositoryOrigin
} from './github-empty-repository.js';

function segment(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

function providerDefaultBase(owner) {
  return `https://${owner.toLowerCase()}.github.io`;
}

function registrationLocation(owner, topology, canonicalBaseUrl) {
  if (topology === 'provider-default') {
    if (canonicalBaseUrl != null) {
      throw new TypeError('--canonical-base-url is valid only with --topology custom-domain');
    }
    return { topology: 'PROVIDER_DEFAULT', canonicalBaseUrl: providerDefaultBase(owner) };
  }
  if (topology !== 'custom-domain') {
    throw new TypeError('topology must be provider-default or custom-domain');
  }
  if (typeof canonicalBaseUrl !== 'string') {
    throw new TypeError('--canonical-base-url is required with --topology custom-domain');
  }
  const canonical = new URL(canonicalBaseUrl);
  if (canonical.protocol !== 'https:' || canonical.username || canonical.password
      || canonical.port || canonical.search || canonical.hash || canonical.pathname !== '/') {
    throw new TypeError('canonicalBaseUrl must be a credential-free HTTPS origin');
  }
  return { topology: 'CUSTOM_DOMAIN', canonicalBaseUrl: canonical.origin };
}

export async function scaffoldSite({
  owner, repository, target, githubInstallationId, siteOptions, emptyExistingRepository = false,
  notify = (message) => process.stdout.write(`${message}\n`), ask, openUrl,
  resumeExistingCheckout = false, topology = 'provider-default', canonicalBaseUrl,
  templateOwner = 'rathnasgala',
  templateRepository = 'site-template',
  readGithub = readGithubCredential, readGala = readGalaCredential,
  createRepository = createPublication, awaitContent = awaitRepositoryContent, clone = cloneRepository,
  configure = configureSite, register = registerSite,
  installVariable = installRepositoryVariable,
  provisionPages = provisionGithubPages,
  commit = commitScaffold, sync = syncScaffold, verifyEmpty = verifyEmptyRepository, setOrigin = setRepositoryOrigin,
  verifyCheckout = verifyRepositoryOrigin
}) {
  const requestedOwner = segment(owner, 'owner');
  const requestedName = segment(repository, 'repository');
  // Validated now so a bad --topology/--canonical-base-url combination fails before a repository
  // exists. The value used later is recomputed once the server says who actually owns it.
  registrationLocation(requestedOwner, topology, canonicalBaseUrl);
  // Optional: the server resolves the installation from the owner when none is supplied. An
  // explicit value is still validated, because a wrong one fails much later and less clearly.
  if (githubInstallationId != null
      && (!Number.isSafeInteger(githubInstallationId) || githubInstallationId <= 0)) {
    throw new TypeError('githubInstallationId must be a positive integer');
  }
  if (target == null || path.resolve(target) === path.parse(path.resolve(target)).root) {
    throw new TypeError('target must be a non-root local path');
  }
  const [github, gala] = await Promise.all([readGithub(), readGala()]);
  // Creation reports which installation owns the new repository, so registration cannot disagree.
  let resolvedInstallationId = githubInstallationId ?? null;
  if (emptyExistingRepository && resumeExistingCheckout) {
    throw new TypeError('emptyExistingRepository and resumeExistingCheckout are mutually exclusive');
  }
  /*
   * The server decides the owner, not this process. It creates under the account the Gala App
   * installation belongs to, which is not always the account behind the writer's OAuth token — an
   * installation on an organisation they belong to gives a different owner entirely. Deriving the
   * canonical URL, the idempotency key, the registration and the Pages target from the local guess
   * would register a publication against a repository that does not exist.
   */
  let repositoryOwner = requestedOwner;
  let repositoryName = requestedName;
  let generated;
  let root;
  if (resumeExistingCheckout) {
    root = await verifyCheckout({
      root: path.resolve(target), owner: repositoryOwner, repository: repositoryName
    });
    generated = { fullName: `${repositoryOwner}/${repositoryName}` };
  } else if (emptyExistingRepository) {
    await verifyEmpty({ owner: repositoryOwner, repository: repositoryName, accessToken: github.accessToken });
    generated = {
      fullName: `${repositoryOwner}/${repositoryName}`,
      cloneUrl: `https://github.com/${templateOwner}/${templateRepository}.git`
    };
  } else {
    /*
     * Created through the API, the same call the browser editor makes. Doing it here meant a second
     * implementation with no fallback and no wait for the App installation to reach the result,
     * which is why CLI-created repositories never appeared in the web UI.
     */
    const created = await createRepository({
      apiBaseUrl: gala.apiBaseUrl, galaAccessToken: gala.accessToken,
      githubAccessToken: github.accessToken, name: repositoryName,
      notify, ask, openUrl, selfLogin: requestedOwner
    });
    repositoryOwner = segment(created.owner, 'owner');
    repositoryName = segment(created.repository, 'repository');
    resolvedInstallationId = created.installationId;
    generated = { fullName: created.fullName, cloneUrl: created.cloneUrl };
    // Creation is asynchronous: GitHub answers before the template content lands, and cloning into
    // that window produces an empty checkout and a missing site.config.yml.
    await awaitContent({
      accessToken: github.accessToken, owner: created.owner, repository: created.repository
    });
  }
  if (!resumeExistingCheckout) {
    root = await clone({ cloneUrl: generated.cloneUrl, target, accessToken: github.accessToken });
    if (emptyExistingRepository) await setOrigin({ root, owner: repositoryOwner, repository: repositoryName });
  }
  const location = registrationLocation(repositoryOwner, topology, canonicalBaseUrl);
  await configure(root, siteOptions ?? {});

  /*
   * The writer's design choices go up before registration, and nothing goes up after it.
   *
   * Registration makes the server write `site.config.yml` and `.github/workflows/publish.yml` into
   * the repository — the same code path the browser editor uses. The CLI used to write its own
   * versions of both files afterwards and commit them, which produced a second commit whose whole
   * content was rewriting `api-base-url` into a `vars` reference and stripping the template's
   * comments. That second commit triggered a second Publish run, which collided with the first
   * one's deployment record and failed:
   *
   *     Assigned-ID source moved on the remote branch: content/posts/example/index.en.md
   *
   * So those two files have one owner now, and it is the server. What is left here is the design
   * configuration, which only the CLI receives — pushed first so the server provisions on top of
   * it rather than around it.
   */
  await commit(root, { accessToken: github.accessToken });

  const idempotencyKey = `scaffold-${createHash('sha256').update(`${repositoryOwner.toLowerCase()}/${repositoryName.toLowerCase()}`).digest('hex')}`;
  const registration = await register({
    apiBaseUrl: gala.apiBaseUrl, galaAccessToken: gala.accessToken,
    githubAccessToken: github.accessToken, idempotencyKey,
    githubInstallationId: resolvedInstallationId, repositoryOwner, repositoryName,
    topology: location.topology, canonicalBaseUrl: location.canonicalBaseUrl
  });

  await installVariable({
    owner: repositoryOwner, repository: repositoryName, accessToken: github.accessToken,
    variableName: 'GALA_API_BASE_URL', variableValue: gala.apiBaseUrl
  });

  // Brings the server's provisioning commits into the checkout, so the writer's working copy holds
  // the publication as it actually exists, and reports the commit publishing will run against.
  const commitSha = await sync(root, { accessToken: github.accessToken });

  /*
   * Pages is only touched for a custom domain.
   *
   * On the provider default it was never doing anything: publishing creates a `gh-pages` branch and
   * GitHub turns on classic Pages by itself — every scaffold produced a live site with
   * `build_type: legacy, source: gh-pages` before this step ran, including runs that failed before
   * reaching it. What the step did cost was up to ten minutes waiting on a workflow run, and a
   * reported failure for a publication that was already serving.
   *
   * A custom domain is different: classic Pages will not point itself at someone's own hostname, so
   * the API call is the thing that does it.
   */
  const pages = location.topology === 'CUSTOM_DOMAIN' ? await provisionPages({
    owner: repositoryOwner, repository: repositoryName, accessToken: github.accessToken, commitSha,
    customDomain: new URL(location.canonicalBaseUrl).hostname
  }) : null;
  return Object.freeze({
    root, fullName: generated.fullName, siteId: registration.siteId, commitSha, pages
  });
}
