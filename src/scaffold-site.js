import { createHash } from 'node:crypto';
import path from 'node:path';

import { configureSite } from './configure-site.js';
import { readGalaCredential } from './gala-credential-store.js';
import { readGithubCredential } from './github-credential-store.js';
import { cloneRepository, generateRepositoryFromTemplate } from './github-template-repository.js';
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
  resumeExistingCheckout = false, topology = 'provider-default', canonicalBaseUrl, actionRef,
  buildMode = 'build-and-deploy', templateOwner = 'rathnasgala',
  templateRepository = 'site-template',
  readGithub = readGithubCredential, readGala = readGalaCredential,
  generate = generateRepositoryFromTemplate, clone = cloneRepository,
  configure = configureSite, register = registerSite, finalize = writeRegisteredSiteConfiguration,
  writeWorkflow = writePublishWorkflow,
  installVariable = installRepositoryVariable,
  provisionPages = provisionGithubPages,
  commit = commitScaffold, verifyEmpty = verifyEmptyRepository, setOrigin = setRepositoryOrigin,
  verifyCheckout = verifyRepositoryOrigin
}) {
  const repositoryOwner = segment(owner, 'owner');
  const repositoryName = segment(repository, 'repository');
  const location = registrationLocation(repositoryOwner, topology, canonicalBaseUrl);
  if (!Number.isSafeInteger(githubInstallationId) || githubInstallationId <= 0) {
    throw new TypeError('githubInstallationId must be a positive integer');
  }
  if (target == null || path.resolve(target) === path.parse(path.resolve(target)).root) {
    throw new TypeError('target must be a non-root local path');
  }
  const [github, gala] = await Promise.all([readGithub(), readGala()]);
  if (emptyExistingRepository && resumeExistingCheckout) {
    throw new TypeError('emptyExistingRepository and resumeExistingCheckout are mutually exclusive');
  }
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
    generated = await generate({
      accessToken: github.accessToken, templateOwner, templateRepository,
      owner: repositoryOwner, repository: repositoryName,
      description: siteOptions?.siteName ?? ''
    });
  }
  if (!resumeExistingCheckout) {
    root = await clone({ cloneUrl: generated.cloneUrl, target });
    if (emptyExistingRepository) await setOrigin({ root, owner: repositoryOwner, repository: repositoryName });
  }
  const configured = await configure(root, siteOptions ?? {});
  const idempotencyKey = `scaffold-${createHash('sha256').update(`${repositoryOwner.toLowerCase()}/${repositoryName.toLowerCase()}`).digest('hex')}`;
  const registration = await register({
    apiBaseUrl: gala.apiBaseUrl, galaAccessToken: gala.accessToken,
    githubAccessToken: github.accessToken, idempotencyKey,
    githubInstallationId, repositoryOwner, repositoryName,
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
