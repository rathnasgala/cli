import { createHash } from 'node:crypto';
import path from 'node:path';

import { configureSite } from './configure-site.js';
import { readGalaCredential } from './gala-credential-store.js';
import { readGithubCredential } from './github-credential-store.js';
import { cloneRepository, generateRepositoryFromTemplate } from './github-template-repository.js';
import { installRepositorySecret } from './github-repository-secret.js';
import { installRepositoryVariable } from './github-repository-variable.js';
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

function providerDefaultBase(owner, repository) {
  const rootRepository = repository.toLowerCase() === `${owner}.github.io`.toLowerCase();
  return `https://${owner.toLowerCase()}.github.io${rootRepository ? '/' : `/${repository}/`}`;
}

export async function scaffoldSite({
  owner, repository, target, githubInstallationId, siteOptions, emptyExistingRepository = false,
  resumeExistingCheckout = false,
  buildMode = 'build-and-deploy', templateOwner = 'rathnasgala',
  templateRepository = 'site-template',
  readGithub = readGithubCredential, readGala = readGalaCredential,
  generate = generateRepositoryFromTemplate, clone = cloneRepository,
  configure = configureSite, register = registerSite, finalize = writeRegisteredSiteConfiguration,
  writeWorkflow = writePublishWorkflow, installSecret = installRepositorySecret,
  installVariable = installRepositoryVariable,
  commit = commitScaffold, verifyEmpty = verifyEmptyRepository, setOrigin = setRepositoryOrigin,
  verifyCheckout = verifyRepositoryOrigin
}) {
  const repositoryOwner = segment(owner, 'owner');
  const repositoryName = segment(repository, 'repository');
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
  const canonicalBaseUrl = providerDefaultBase(repositoryOwner, repositoryName);
  const idempotencyKey = `scaffold-${createHash('sha256').update(`${repositoryOwner.toLowerCase()}/${repositoryName.toLowerCase()}`).digest('hex')}`;
  const registration = await register({
    apiBaseUrl: gala.apiBaseUrl, galaAccessToken: gala.accessToken, idempotencyKey,
    githubInstallationId, repositoryOwner, repositoryName,
    topology: 'PROVIDER_DEFAULT', canonicalBaseUrl
  });
  await finalize(root, {
    siteId: registration.siteId,
    canonicalBaseUrl: registration.canonicalBaseUrl,
    topology: 'provider-default'
  });
  await writeWorkflow({
    root, siteId: registration.siteId, timezone: configured.site.timezone, buildMode
  });
  await installSecret({
    owner: repositoryOwner, repository: repositoryName, accessToken: github.accessToken,
    secretName: 'GALA_SITE_SECRET', secretValue: registration.siteSecret
  });
  await installVariable({
    owner: repositoryOwner, repository: repositoryName, accessToken: github.accessToken,
    variableName: 'GALA_API_BASE_URL', variableValue: gala.apiBaseUrl
  });
  await commit(root);
  return Object.freeze({ root, fullName: generated.fullName, siteId: registration.siteId });
}
