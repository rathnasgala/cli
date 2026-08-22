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
import { writeRegisteredSiteConfiguration } from './site-config-registration.js';
import { writePublishWorkflow } from './workflow-command.js';
import { commitScaffold } from './scaffold-git.js';
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
  resumeExistingCheckout = false, topology = 'provider-default', canonicalBaseUrl, actionRef,
  buildMode = 'build-and-deploy', templateOwner = 'rathnasgala',
  templateRepository = 'site-template',
  readGithub = readGithubCredential, readGala = readGalaCredential,
  createRepository = createPublication, awaitContent = awaitRepositoryContent, clone = cloneRepository,
  configure = configureSite, register = registerSite, finalize = writeRegisteredSiteConfiguration,
  writeWorkflow = writePublishWorkflow,
  installVariable = installRepositoryVariable,
  provisionPages = provisionGithubPages,
  commit = commitScaffold, verifyEmpty = verifyEmptyRepository, setOrigin = setRepositoryOrigin,
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
      notify, ask, openUrl
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
    root = await clone({ cloneUrl: generated.cloneUrl, target });
    if (emptyExistingRepository) await setOrigin({ root, owner: repositoryOwner, repository: repositoryName });
  }
  const location = registrationLocation(repositoryOwner, topology, canonicalBaseUrl);
  const configured = await configure(root, siteOptions ?? {});
  const idempotencyKey = `scaffold-${createHash('sha256').update(`${repositoryOwner.toLowerCase()}/${repositoryName.toLowerCase()}`).digest('hex')}`;
  const registration = await register({
    apiBaseUrl: gala.apiBaseUrl, galaAccessToken: gala.accessToken,
    githubAccessToken: github.accessToken, idempotencyKey,
    githubInstallationId: resolvedInstallationId, repositoryOwner, repositoryName,
    topology: location.topology, canonicalBaseUrl: location.canonicalBaseUrl
  });
  await finalize(root, {
    siteId: registration.siteId,
    canonicalBaseUrl: registration.canonicalBaseUrl,
    pathPrefix: registration.pathPrefix,
    topology
  });
  await writeWorkflow({
    root, siteId: registration.siteId, timezone: configured.site.timezone, buildMode,
    ...(actionRef == null ? {} : { actionRef })
  });
  await installVariable({
    owner: repositoryOwner, repository: repositoryName, accessToken: github.accessToken,
    variableName: 'GALA_API_BASE_URL', variableValue: gala.apiBaseUrl
  });
  const commitSha = await commit(root);
  const pages = buildMode === 'build-and-deploy' ? await provisionPages({
    owner: repositoryOwner, repository: repositoryName, accessToken: github.accessToken, commitSha,
    customDomain: location.topology === 'CUSTOM_DOMAIN' ? new URL(location.canonicalBaseUrl).hostname : null
  }) : null;
  return Object.freeze({
    root, fullName: generated.fullName, siteId: registration.siteId, commitSha, pages
  });
}
