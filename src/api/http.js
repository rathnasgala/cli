/**
 * Every HTTP call the CLI makes, and every failure it reports.
 *
 * v0 threw away the response body at all twenty failure sites — `failed with HTTP 403` and nothing
 * else. GitHub explains which 403 it is in that body and nowhere else: an organisation's OAuth App
 * restrictions, a missing permission, a rename and a rate limit all arrive as 403 with a sentence
 * telling them apart. Diagnosing anything meant guessing between causes the server had already
 * distinguished, and it cost days.
 *
 * Only the response is read here. Request bodies, tokens and secrets never pass through.
 */
const MAX_DETAIL = 400;

export class HttpError extends Error {
  constructor(status, action, detail, code) {
    super(detail === '' ? `${action} failed with HTTP ${status}` : `${action} failed: ${detail}`);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export async function request(url, { action, ...options } = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (unreachable) {
    throw new Error(`${action} could not reach ${new URL(url).host}: ${unreachable.message}`);
  }
  if (response.ok) return response;

  const body = await readBody(response);
  throw new HttpError(response.status, action, describe(body), body?.code);
}

export async function requestJson(url, options) {
  const response = await request(url, options);
  if (response.status === 204) return undefined;
  return response.json();
}

async function readBody(response) {
  try {
    const text = await response.text();
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } catch {
    return null;
  }
}

function describe(body) {
  if (body == null) return '';
  const parts = [];
  if (typeof body.message === 'string' && body.message.trim() !== '') parts.push(body.message.trim());
  // GitHub's `errors` array carries the specific field or reason behind a generic message.
  for (const error of Array.isArray(body.errors) ? body.errors : []) {
    const reason = typeof error === 'string' ? error : error?.message ?? error?.code;
    if (typeof reason === 'string' && reason.trim() !== '') parts.push(reason.trim());
  }
  if (typeof body.error_description === 'string') parts.push(body.error_description.trim());
  if (parts.length === 0 && typeof body.code === 'string') parts.push(body.code);
  if (parts.length === 0 && typeof body.raw === 'string') parts.push(body.raw);
  if (typeof body.documentation_url === 'string') parts.push(`See ${body.documentation_url}`);

  const detail = parts.join(' — ').replace(/\s+/g, ' ').trim();
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail;
}
