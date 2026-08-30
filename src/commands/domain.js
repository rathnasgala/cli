import path from 'node:path';

import { galaApi } from '../api/gala.js';
import { HttpError } from '../api/http.js';
import { accountForCommand } from '../auth/checkout-profile.js';
import { authenticatedProfile } from '../auth/profiles.js';
import { UsageError } from '../cli/args.js';
import { cliCommand } from '../cli/invocation.js';
import { customDomain } from '../domain.js';
import { readPublication } from '../publication.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export async function domain({ terminal, options, cwd = process.cwd() }) {
  const root = path.resolve(options.value('root') ?? cwd);
  const publication = await readPublication(root);
  if (!publication || !ULID.test(publication.siteId ?? '')) {
    throw new UsageError('Run this inside a registered Gala publication, or pass --root.');
  }
  const [action = 'status', value, ...extra] = options.positional;
  if (extra.length > 0 || !['status', 'set', 'check', 'cancel', 'remove'].includes(action)) {
    throw new UsageError(`Use: ${cliCommand('domain [status|set <hostname>|check|cancel|remove]')}`);
  }
  if (action === 'set' && value == null) throw new UsageError('domain set needs a hostname');
  if (action !== 'set' && value != null) throw new UsageError(`domain ${action} takes no hostname`);

  const account = await accountForCommand(options, root, { terminal });
  const profile = await authenticatedProfile({ name: account, terminal });
  const credential = profile.gala;
  const api = galaApi({ baseUrl: credential.apiBaseUrl, token: credential.accessToken });

  if (action === 'status') {
    const pending = await api.pendingTopologyChange(publication.siteId);
    if (!pending) {
      terminal.result((await ownedSite(api, publication.siteId)).publicationUrl);
      terminal.done('No domain change is pending');
      return null;
    }
    showPending(terminal, pending);
    return pending;
  }

  if (action === 'set') {
    const checked = customDomain(value);
    if (checked.error) throw new UsageError(checked.error);
    const site = await ownedSite(api, publication.siteId);
    const requestedUrl = `https://${checked.host}/`;
    const existing = await api.pendingTopologyChange(publication.siteId);
    if (!existing && sameAddress(site.publicationUrl, requestedUrl)) {
      terminal.done(`${requestedUrl} is already this publication’s configured address`);
      return null;
    }
    if (existing && (existing.cname !== checked.host || existing.pathPrefix !== '/')) {
      throw new UsageError(`A change to ${existing.canonicalBaseUrl}${existing.pathPrefix} is already pending. `
        + `Resume it with ${cliCommand('domain check')}, or cancel it with ${cliCommand('domain cancel')}.`);
    }
    const change = existing ?? await api.prepareTopologyChange(publication.siteId, {
      canonicalBaseUrl: `https://${checked.host}`,
      pathPrefix: '/',
    });
    if (existing) terminal.note(`Resuming the pending change to ${checked.host}.`);
    else terminal.done(`Reserved ${checked.host}`);
    return advanceDomain({ api, siteId: publication.siteId, pending: change, site,
      login: profile.metadata.githubLogin, terminal });
  }

  if (action === 'remove') {
    const existing = await api.pendingTopologyChange(publication.siteId);
    const site = await ownedSite(api, publication.siteId);
    const [owner, repository] = site.repository.split('/');
    const host = `${owner.toLowerCase()}.github.io`;
    const prefix = repository.toLowerCase() === host ? '/' : `/${repository}`;
    const providerUrl = `https://${host}${prefix === '/' ? '/' : `${prefix}/`}`;
    if (sameAddress(site.publicationUrl, providerUrl)) {
      terminal.done(`${providerUrl} is already this publication’s configured address`);
      return null;
    }
    if (existing && (existing.cname !== null
        || existing.canonicalBaseUrl !== `https://${host}` || existing.pathPrefix !== prefix)) {
      throw new UsageError(`A change to ${existing.canonicalBaseUrl}${existing.pathPrefix} is already pending. `
        + `Resume it with ${cliCommand('domain check')}, or cancel it with ${cliCommand('domain cancel')}.`);
    }
    const change = existing ?? await api.prepareTopologyChange(publication.siteId, {
      canonicalBaseUrl: `https://${host}`,
      pathPrefix: prefix,
    });
    if (existing) terminal.note('Resuming removal of the custom domain.');
    return advanceDomain({ api, siteId: publication.siteId, pending: change, site,
      login: profile.metadata.githubLogin, terminal, removing: true });
  }

  const pending = await api.pendingTopologyChange(publication.siteId);
  if (!pending) {
    const site = await ownedSite(api, publication.siteId);
    terminal.result(site.publicationUrl);
    terminal.done('No domain change is pending');
    return null;
  }

  if (action === 'cancel') {
    await api.discardTopologyChange(publication.siteId, pending.changeId);
    terminal.done('Cancelled the pending domain change');
    terminal.note('GitHub Pages and the publication source were restored to the committed address.');
    if (pending.cname) terminal.note(`Remove DNS records for ${pending.cname} if they are no longer used.`);
    return null;
  }

  if (action === 'check') {
    const site = await ownedSite(api, publication.siteId);
    return advanceDomain({ api, siteId: publication.siteId, pending, site,
      login: profile.metadata.githubLogin, terminal, removing: !pending.cname });
  }

  throw new UsageError(`Unsupported domain action: ${action}`);
}

async function advanceDomain({ api, siteId, pending, site, login, terminal, removing = false }) {
  let current = pending;
  if (current.cname && current.state === 'PREPARED') {
    terminal.step('Checking GitHub domain ownership and repository configuration');
    try {
      current = await configureWithRetry(api, siteId, current.changeId, terminal);
    } catch (failure) {
      return handleDomainFailure(failure, terminal, current, site, login);
    }
    terminal.done(`GitHub verified and accepted ${current.cname}`);
  }
  terminal.step(current.cname
    ? 'Checking DNS, certificate, and HTTPS'
    : 'Restoring the GitHub Pages address');
  let committed;
  try {
    committed = await api.commitTopologyChange(siteId, current.changeId);
  } catch (failure) {
    return handleDomainFailure(failure, terminal, current, site, login);
  }
  terminal.done(committed.cname
    ? `https://${committed.cname}/ is live with enforced HTTPS`
    : 'The GitHub Pages address is live again');
  if (removing || !committed.cname) {
    terminal.note('Remove the old custom-domain records from your DNS provider.');
  }
  return committed;
}

async function configureWithRetry(api, siteId, changeId, terminal) {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await api.configureTopologyChange(siteId, changeId);
    } catch (failure) {
      const waiting = failure instanceof HttpError && [
        'GITHUB_PAGES_DOMAIN_VERIFICATION_REQUIRED',
        'GITHUB_PAGES_DOMAIN_PROPAGATION_PENDING',
      ].includes(failure.code);
      if (!waiting || attempt === attempts) throw failure;
      if (attempt === 1) terminal.step('Waiting for GitHub Pages to finish applying the domain');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error('GitHub Pages domain check ended unexpectedly');
}

function handleDomainFailure(failure, terminal, pending, site, login) {
  if (!(failure instanceof HttpError)) throw failure;
  const [owner, repository] = site.repository.split('/');
  const retry = cliCommand('domain check');
  const address = pending.cname ?? 'the GitHub Pages address';
  switch (failure.code) {
    case 'GITHUB_PAGES_DOMAIN_VERIFICATION_REQUIRED':
      terminal.note(`GitHub Pages already holds ${pending.cname}; publishing remains safe while ownership verification is pending.`);
      showVerificationSteps(terminal, pending.cname, owner, login);
      return pending;
    case 'GITHUB_PAGES_DOMAIN_PROPAGATION_PENDING':
      terminal.openUrl(repositoryPagesUrl(owner, repository));
      terminal.note(`GitHub accepted ${address} and is still updating its Pages state.`);
      terminal.note(`No action is required. Publishing remains safe; retry with: ${retry}`);
      return pending;
    case 'GITHUB_PAGES_DNS_PENDING':
      terminal.note(dnsInstruction(pending.cname, `${owner.toLowerCase()}.github.io`));
      terminal.openUrl(repositoryPagesUrl(owner, repository));
      terminal.note(`After saving the DNS records, propagation can take up to 24 hours. Retry with: ${retry}`);
      return pending;
    case 'GITHUB_PAGES_CERTIFICATE_PENDING':
      terminal.openUrl(repositoryPagesUrl(owner, repository));
      terminal.note(`DNS is accepted. GitHub is provisioning the HTTPS certificate for ${pending.cname}.`);
      terminal.note(`No action is normally required. If it remains pending, check conflicting DNS and CAA records. Retry with: ${retry}`);
      return pending;
    case 'GITHUB_PAGES_DNS_INVALID':
      terminal.note(dnsInstruction(pending.cname, `${owner.toLowerCase()}.github.io`));
      throw new Error(`GitHub rejected the DNS records for ${pending.cname}. Correct them, then run: ${retry}`);
    case 'GITHUB_PAGES_PERMISSION_REQUIRED':
      terminal.openUrl(owner.toLowerCase() === login.toLowerCase()
        ? 'https://github.com/settings/installations'
        : `https://github.com/organizations/${encodeURIComponent(owner)}/settings/installations`);
      throw new Error(`The Gala GitHub App needs Pages and Administration access to ${owner}/${repository}. Grant it, then run: ${retry}`);
    case 'GITHUB_PAGES_DOMAIN_REJECTED':
      terminal.openUrl(repositoryPagesUrl(owner, repository));
      throw new Error(`GitHub rejected ${address}. Review the repository’s Pages settings, then run: ${retry}`);
    case 'GITHUB_PAGES_TOPOLOGY_NOT_READY':
      terminal.openUrl(repositoryPagesUrl(owner, repository));
      terminal.note(`GitHub Pages is finishing HTTPS and the final address for ${address}.`);
      terminal.note(`No action is required. Retry with: ${retry}`);
      return pending;
    case 'GITHUB_PAGES_VERIFICATION_UNAVAILABLE':
      terminal.note(`GitHub Pages is temporarily unavailable. The pending change is preserved; retry later with: ${retry}`);
      return pending;
    case 'SITE_TOPOLOGY_STATE_CONFLICT':
      throw new Error(`This domain change is no longer in the expected state. Inspect it with: ${cliCommand('domain status')}`);
    default:
      throw failure;
  }
}

function repositoryPagesUrl(owner, repository) {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/settings/pages`;
}

function showVerificationSteps(terminal, host, owner, login) {
  terminal.note(`GitHub owner @${owner} must verify ${host} once under Settings → Pages → Verified domains.`);
  terminal.openUrl(owner.toLowerCase() === login.toLowerCase()
    ? 'https://github.com/settings/pages'
    : `https://github.com/organizations/${encodeURIComponent(owner)}/settings/pages`);
  terminal.note(`Choose “Add a domain”, enter ${host}, and add GitHub’s TXT record at your DNS provider.`);
  terminal.note(`The TXT record name will be _github-pages-challenge-${owner}.${host}; GitHub supplies its value.`);
  terminal.note('Keep the TXT record after verification so the domain remains protected.');
  terminal.note(`When GitHub shows “Verified”, run: ${cliCommand('domain check')}`);
}

async function ownedSite(api, siteId) {
  const sites = await api.listPublications();
  const site = Array.isArray(sites) ? sites.find((candidate) => candidate.siteId === siteId) : null;
  if (!site || typeof site.repository !== 'string' || typeof site.publicationUrl !== 'string') {
    throw new Error('Publication is not available');
  }
  return site;
}

function dnsInstruction(host, target) {
  return `DNS action required:\n  Subdomain: CNAME ${host} → ${target} (do not include the repository name).\n`
    + '  Apex domain: use GitHub Pages A/AAAA records, or an ALIAS/ANAME to the same github.io target.';
}

function showPending(terminal, pending) {
  terminal.result(`${pending.canonicalBaseUrl}${pending.pathPrefix}`);
  if (pending.state === 'PREPARED') {
    terminal.note('GitHub configuration or domain ownership verification is pending.');
  } else {
    terminal.note('GitHub accepted the domain; DNS, certificate, or HTTPS activation is pending.');
  }
  terminal.note(`Continue with: ${cliCommand('domain check')}`);
}

function sameAddress(left, right) {
  return String(left).replace(/\/+$/, '') === String(right).replace(/\/+$/, '');
}
