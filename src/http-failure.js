/**
 * What the server actually said, instead of only what it scored.
 *
 * Every failure in this CLI reported `failed with HTTP 403` and discarded the response body. GitHub
 * puts the reason there and nowhere else — an organisation's OAuth App restrictions, a missing
 * scope, a rename, a rate limit all arrive as 403 with a sentence explaining which — so the one
 * fact worth having was the one being thrown away. Diagnosing anything meant guessing between
 * causes the server had already distinguished.
 *
 * Only the response is read. Request bodies, tokens and secrets never pass through here.
 */
const MAX_DETAIL = 400;

export async function describeHttpFailure(response, action) {
  const status = response?.status ?? 0;
  let detail = '';
  try {
    // Cloned so a caller that also reads the body still can; a response whose body is already
    // consumed simply yields no detail rather than a second failure on top of the first.
    const text = await (typeof response.clone === 'function' ? response.clone() : response).text();
    detail = extract(text);
  } catch {
    detail = '';
  }
  return `${action} failed with HTTP ${status}${detail === '' ? '' : `: ${detail}`}`;
}

function extract(text) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return truncate(text);
  }
  if (payload == null || typeof payload !== 'object') return truncate(text);
  const parts = [];
  if (typeof payload.message === 'string' && payload.message.trim() !== '') parts.push(payload.message.trim());
  // GitHub's `errors` array carries the specific field or reason behind a generic message.
  if (Array.isArray(payload.errors)) {
    for (const error of payload.errors) {
      const reason = typeof error === 'string' ? error : error?.message ?? error?.code;
      if (typeof reason === 'string' && reason.trim() !== '') parts.push(reason.trim());
    }
  }
  if (typeof payload.error_description === 'string') parts.push(payload.error_description.trim());
  if (typeof payload.code === 'string' && parts.length === 0) parts.push(payload.code);
  if (typeof payload.documentation_url === 'string') parts.push(`See ${payload.documentation_url}`);
  return truncate(parts.length === 0 ? text : parts.join(' — '));
}

function truncate(value) {
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length > MAX_DETAIL ? `${flattened.slice(0, MAX_DETAIL)}…` : flattened;
}
