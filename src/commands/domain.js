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
      terminal.note('No domain change is pending.');
      return null;
    }
    showPending(terminal, pending);
    return pending;
  }

  if (action === 'set') {
    const checked = customDomain(value);
    if (checked.error) throw new UsageError(checked.error);
    const site = await ownedSite(api, publication.siteId);
    const owner = site.repository.split('/')[0];
    const change = await api.prepareTopologyChange(publication.siteId, {
      canonicalBaseUrl: `https://${checked.host}`,
      pathPrefix: '/',
    });
    terminal.done(`Reserved ${checked.host}`);
    showVerificationSteps(terminal, checked.host, owner, profile.metadata.githubLogin);
    return change;
  }

  if (action === 'remove') {
    const existing = await api.pendingTopologyChange(publication.siteId);
    if (existing) {
      throw new UsageError('No second domain change can start while another one is pending; cancel it first.');
    }
    const site = await ownedSite(api, publication.siteId);
    const [owner, repository] = site.repository.split('/');
    const host = `${owner.toLowerCase()}.github.io`;
    const prefix = repository.toLowerCase() === host ? '/' : `/${repository}`;
    const change = await api.prepareTopologyChange(publication.siteId, {
      canonicalBaseUrl: `https://${host}`,
      pathPrefix: prefix,
    });
    const committed = await api.commitTopologyChange(publication.siteId, change.changeId);
    terminal.done(`Returned to ${committed.canonicalBaseUrl}${prefix === '/' ? '/' : `${prefix}/`}`);
    terminal.note('Remove the old custom-domain records from your DNS provider.');
    return committed;
  }

  const pending = await api.pendingTopologyChange(publication.siteId);
  if (!pending) throw new UsageError('No domain change is pending.');

  if (action === 'cancel') {
    await api.discardTopologyChange(publication.siteId, pending.changeId);
    terminal.done('Cancelled the pending domain change');
    return null;
  }

  if (action === 'check') {
    const site = await ownedSite(api, publication.siteId);
    if (pending.cname && pending.state === 'PREPARED') {
      let configured;
      try {
        configured = await configureWithRetry(api, publication.siteId, pending.changeId, terminal);
      } catch (failure) {
        handleDomainFailure(failure, terminal, pending, site, profile.metadata.githubLogin);
      }
      terminal.done(`GitHub verified ${configured.cname}`);
      terminal.note(dnsInstruction(configured.cname, await providerHost(api, publication.siteId)));
      terminal.note(`After DNS propagates, run: ${cliCommand('domain check')}`);
      return configured;
    }
    let committed;
    try {
      committed = await api.commitTopologyChange(publication.siteId, pending.changeId);
    } catch (failure) {
      handleDomainFailure(failure, terminal, pending, site, profile.metadata.githubLogin);
    }
    terminal.done(committed.cname
      ? `${committed.cname} is live with enforced HTTPS`
      : 'The GitHub Pages address is live again');
    if (!committed.cname) {
      terminal.note('Remove the old custom-domain records from your DNS provider.');
    }
    return committed;
  }

  throw new UsageError(`Unsupported domain action: ${action}`);
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
      terminal.openUrl(repositoryPagesUrl(owner, repository));
      terminal.note('GitHub’s Custom domain panel shows the current verification, DNS, and HTTPS status.');
      throw new Error(`GitHub Pages has not accepted ${pending.cname} yet. Follow its Custom domain status, then run: ${retry}`);
    case 'GITHUB_PAGES_DOMAIN_PROPAGATION_PENDING':
      terminal.openUrl(repositoryPagesUrl(owner, repository));
      terminal.note('GitHub’s Custom domain panel shows the current verification, DNS, and HTTPS status.');
      throw new Error(`GitHub accepted ${address} and is still updating Pages. Wait briefly, then run: ${retry}`);
    case 'GITHUB_PAGES_DNS_PENDING':
      terminal.note(dnsInstruction(pending.cname, `${owner.toLowerCase()}.github.io`));
      throw new Error(`GitHub is still checking DNS for ${pending.cname}. After it propagates, run: ${retry}`);
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
      throw new Error(`GitHub Pages has not finished applying ${address}. Wait briefly, then run: ${retry}`);
    case 'GITHUB_PAGES_VERIFICATION_UNAVAILABLE':
      throw new Error(`GitHub Pages is temporarily unavailable. Your pending change is preserved; run later: ${retry}`);
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

async function providerHost(api, siteId) {
  return (await ownedSite(api, siteId)).repository.split('/')[0].toLowerCase() + '.github.io';
}

function dnsInstruction(host, target) {
  return `For a subdomain: CNAME ${host} → ${target}. For an apex domain, use GitHub’s documented A/AAAA records.`;
}

function showPending(terminal, pending) {
  terminal.result(`${pending.canonicalBaseUrl}${pending.pathPrefix}`);
  terminal.note(`State: ${pending.state}`);
  if (pending.state === 'PREPARED') terminal.note(`Next: verify ownership, then run ${cliCommand('domain check')}.`);
  else terminal.note(`Next: configure DNS, then run ${cliCommand('domain check')}.`);
}
