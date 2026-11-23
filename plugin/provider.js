/* MetroFuse provider ports, GPL-3.0. */
export const array = value => Array.isArray(value) ? value : [];
export const text = value => typeof value === 'string' ? value.trim() : '';
export const cleanIsrc = value => {
  const code = text(value).replace(/[^a-z0-9]/gi, '').toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(code) ? code : '';
};
export const bounded = (value, fallback = 30, max = 100) => Math.max(1, Math.min(max, Math.trunc(Number(value) || fallback)));
export const asArray = value => Array.isArray(value) ? value : array(value?.items ?? value?.collection);

export function httpsHost(url) {
  return text(url).match(/^https:\/\/([a-z0-9.-]+)(?::443)?(?:[/?#]|$)/i)?.[1]?.toLowerCase() ?? '';
}

export function publicHttps(url) {
  const host = httpsHost(url);
  return host.includes('.') && !/^[\d.]+$/.test(host) && !/\.(?:local|localhost|internal|test)$/.test(host);
}

export function query(url, params) {
  const [path, original = ''] = url.split('?', 2);
  const keep = original.split('&').filter(part => part && !Object.hasOwn(params, part.split('=')[0]));
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') keep.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  return keep.length ? path + '?' + keep.join('&') : path;
}

export function numericId(value) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
  return /^\d{1,20}$/.test(id) ? id : '';
}

export function unowned(value, owner) {
  const prefix = 'metrofuse:' + owner + ':';
  return text(value).startsWith(prefix) ? value.slice(prefix.length) : text(value);
}

export async function soft(operation, fallback = null) {
  try { return await operation(); } catch { return fallback; }
}

export class HttpError extends Error {
  constructor(status) {
    super('Provider HTTP ' + status);
    this.status = status;
  }
}

export async function json(host, url, options = {}) {
  const result = await host.http({url, timeoutMs: 8000, maxBytes: 2 * 1024 * 1024, ...options});
  if (result.status < 200 || result.status >= 300) throw new HttpError(result.status);
  return result.body ? JSON.parse(result.body) : {};
}

export function failure(code, message, retryable = false) {
  return {error: {code, message, retryable}};
}

export function requestFailure(error, name) {
  if ([401, 403].includes(error?.status)) return failure('LOGIN_REQUIRED', 'Sign in to ' + name + ' for this track');
  if (error?.status === 404) return failure('NOT_FOUND', 'Track is unavailable on ' + name);
  if (error?.status === 451) return failure('GEO_BLOCKED', 'Track is unavailable in this region');
  return failure('UNAVAILABLE', name + ' is temporarily unavailable', error?.status === 429 || !error?.status || error.status >= 500);
}

export function uniq(items, key = value => value.id) {
  const seen = new Set();
  return items.filter(value => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export async function expectation(host, request) {
  const identity = request.identity ?? {};
  const track = await soft(() => host.track(identity));
  const configured = request.configuration ?? {};
  return {
    isrc: cleanIsrc(identity.isrc ?? identity.identifiers?.isrc ?? track?.extras?.isrc),
    title: text(track?.title ?? configured.title),
    artist: text(track?.artist ?? configured.artist),
    album: text(track?.album ?? configured.album),
    duration: Number(track?.duration ?? configured.duration) || 0,
  };
}

function normal(value) {
  return text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const version = /\b(live|remix|acoustic|instrumental|karaoke|sped up|slowed|nightcore|cover|demo)\b/g;
const versions = value => [...normal(value).matchAll(version)].map(match => match[0]);
const simpleTitle = value => normal(text(value).replace(/\b(?:official (?:music )?video|official audio|lyrics video)\b/gi, ''));
const simpleArtist = value => normal(text(value).replace(/\s*-\s*topic$/i, ''));
const includesWords = (a, b) => (' ' + a + ' ').includes(' ' + b + ' ');

export function matchScore(wanted, candidate) {
  const expected = wanted.isrc;
  const actual = cleanIsrc(candidate.extras?.isrc);
  if (expected && actual === expected) return 1000;
  const title = simpleTitle(wanted.title), gotTitle = simpleTitle(candidate.title);
  const artist = simpleArtist(wanted.artist), gotArtist = simpleArtist(candidate.artist);
  if (!title || !gotTitle || !artist || !gotArtist) return 0;
  const titleScore = title === gotTitle ? 70 : includesWords(title, gotTitle) || includesWords(gotTitle, title) ? 40 : 0;
  const artistScore = artist === gotArtist ? 50 : includesWords(artist, gotArtist) || includesWords(gotArtist, artist) ? 35 : 0;
  if (!titleScore || !artistScore) return 0;
  const expectedVersions = versions(wanted.title + ' ' + wanted.album);
  const actualVersions = versions(candidate.title + ' ' + candidate.album);
  if (actualVersions.some(tag => !expectedVersions.includes(tag)) || expectedVersions.some(tag => !actualVersions.includes(tag))) return 0;
  const distance = wanted.duration && candidate.duration ? Math.abs(wanted.duration - candidate.duration) : 0;
  if (distance > 8000) return 0;
  const albumBonus = wanted.album && normal(candidate.album) === normal(wanted.album) ? 10 : 0;
  return titleScore + artistScore + albumBonus - (distance > 3500 ? 15 : 0);
}

export function matches(wanted, candidates, convert) {
  return candidates.map(value => ({value, candidate: convert(value)}))
    .filter(entry => entry.candidate)
    .map(entry => ({...entry, score: matchScore(wanted, entry.candidate)}))
    .filter(entry => entry.score >= 90)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.value);
}

export function shelf(title, items) {
  return {title, items: uniq(items.filter(Boolean), item => Object.values(item)[0].id)};
}

export function putBounded(cache, key, value, limit = 160) {
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value);
}
