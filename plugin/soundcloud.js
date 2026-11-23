/* Based on the original MetroFuse SoundCloud providers at 5ba186773. GPL-3.0. */
import {
  array, asArray, bounded, cleanIsrc, expectation, failure, httpsHost, json, matches, numericId,
  putBounded, query, requestFailure, shelf, soft, text, uniq, unowned,
} from './provider.js';

const owner = 'metrofuse.soundcloud';
const web = 'https://soundcloud.com/';
const api = 'https://api-v2.soundcloud.com';
const browser = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const apiHosts = ['api-v2.soundcloud.com', 'api.soundcloud.com'];
const cdn = url => httpsHost(url).endsWith('.sndcdn.com');
const playableHost = url => cdn(url) || httpsHost(url) === 'playback.media-streaming.soundcloud.cloud';
const permalink = url => ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com', 'snd.sc'].includes(httpsHost(url));
const unwrap = value => value?.track ?? value?.playlist ?? value?.system_playlist ?? value?.item ??
  (value?.kind || value?.title || value?.id ? value : value?.user ?? value);

function authToken(value) {
  const input = text(value);
  if (!input || input.length > 16384) return '';
  const raw = input.replace(/^(?:OAuth|Bearer)\s+/i, '');
  return /^[A-Za-z0-9._~+/-]{16,}={0,2}$/.test(raw) ? raw :
    input.match(/(?:soundcloud[_-]?)?(?:oauth|access)[_-]?token["'\s:=]+["']?([A-Za-z0-9._~+/-]{16,}={0,2})/i)?.[1] ?? '';
}

function scId(value) {
  const urn = text(value?.urn).match(/:(\d{1,20})$/)?.[1];
  return urn || numericId(value?.id);
}

function artwork(value) {
  const url = text(value?.artwork_url ?? value?.avatar_url ?? value?.artwork);
  return cdn(url) ? url.replace(/-(?:large|small|tiny|badge|crop|t\d+x\d+)(?=\.[^./?]+(?:\?|$))/i, '-t500x500') : '';
}

function playable(track) {
  return track && track.streamable !== false && !['SNIP', 'BLOCK'].includes(text(track.policy).toUpperCase());
}

function convertTrack(value) {
  const item = unwrap(value), id = scId(item);
  if (!id || !text(item?.title) || (item.kind && item.kind !== 'track')) return null;
  const publisher = item.publisher_metadata;
  const extra = {provider: 'soundcloud', soundcloud: id, 'soundcloud.track': id};
  const isrc = cleanIsrc(publisher?.isrc ?? publisher?.isrc_code ?? item.isrc);
  if (isrc) extra.isrc = isrc;
  if (permalink(item.permalink_url)) extra.permalink = item.permalink_url;
  if (scId(item.user)) extra.artistIds = 'soundcloud:user:' + scId(item.user);
  return {id: 'soundcloud:track:' + id, title: text(item.title),
    artist: text(publisher?.artist ?? item.user?.username ?? item.label_name),
    album: text(publisher?.album_title ?? publisher?.album),
    duration: Math.max(0, Math.round(Number(item.full_duration ?? item.duration) || 0)),
    artwork: artwork(item) || artwork(item.user), extras: extra};
}

function convertArtist(value, tracks = [], albums = []) {
  const item = value?.user ?? value, id = scId(item);
  if (!id || !text(item?.username)) return null;
  return {id: 'soundcloud:user:' + id, name: text(item.username), artwork: artwork(item), tracks, albums};
}

function collectionKind(item) {
  return item?.is_album === true || ['album', 'ep', 'compilation', 'single'].includes(text(item?.set_type).toLowerCase()) ? 'album' : 'playlist';
}

function collectionKey(item) {
  const urn = text(item?.urn);
  if (/^soundcloud:(?:system-playlists|track-stations|selections):[a-z0-9_-]{1,160}$/i.test(urn)) return urn;
  return scId(item) ? 'soundcloud:playlist:' + scId(item) : '';
}

function convertCollection(value, songs = [], kind) {
  const item = unwrap(value), id = collectionKey(item);
  if (!id || !text(item?.title) || ['track', 'user'].includes(item.kind) || item.media) return null;
  const author = text(item.user?.username ?? item.username ?? item.subtitle);
  const fields = {id, title: text(item.title), artwork: artwork(item) || artwork(array(item.tracks)[0]), tracks: songs};
  return (kind ?? collectionKind(item)) === 'album' ? {...fields, artist: author} : {...fields, author};
}

function identityKey(identity) {
  const ids = identity?.identifiers ?? {};
  for (const value of [ids.soundcloud, ids['soundcloud.track'], ids.providerTrackId, identity?.canonicalId]) {
    const key = unowned(value, owner);
    if (permalink(key)) return key;
    const explicit = key.match(/^soundcloud:tracks?:(\d{1,20})$/i)?.[1];
    if (explicit) return explicit;
    if ((value === ids.soundcloud || value === ids['soundcloud.track'] || ids.pluginOwner === owner || text(value).startsWith('metrofuse:' + owner + ':')) && numericId(key)) return key;
  }
  return '';
}

const header = {Referer: web, Origin: 'https://soundcloud.com', 'User-Agent': browser};
const performanceHeaders = {...header, Accept: 'audio/*,*/*;q=0.8', 'Accept-Encoding': 'identity'};

function clientInfo(source) {
  const clientId = source.match(/client_?id["']?\s*[:=]\s*["']([a-z0-9]{20,64})["']/i)?.[1];
  const appVersion = source.match(/app_?version["']?\s*[:=]\s*["'](\d{8,})["']/i)?.[1];
  return {clientId, appVersion};
}

function codecFor(mime) {
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  if (/aac|mp4/.test(mime)) return 'aac';
  if (/opus/.test(mime)) return 'opus';
  return '';
}

function transcodings(track, quality, settings) {
  const requested = settings === 'MP3_128' ? {codec: 'mp3', bitrate: 128000} :
    settings === 'AAC_96' || quality?.preset === 'LOW' ? {codec: 'aac', bitrate: 96000} :
    {codec: 'aac', bitrate: 160000};
  return array(track.media?.transcodings).map(item => {
    const mime = text(item.format?.mime_type).toLowerCase();
    const codec = codecFor(mime);
    const protocol = text(item.format?.protocol).toLowerCase();
    if (!['progressive','hls'].includes(protocol) || !codec || !apiHosts.includes(httpsHost(item.url)) ||
        item.snipped === true || /(?:preview|snipped)/i.test(item.preset ?? '') || /\/(?:preview|snipped)(?:\/|$)/i.test(item.url)) return null;
    const preset = text(item.preset).match(/(?:aac|mp3|opus)[_-]?(\d{2,3})(?:\b|_)/i)?.[1];
    let bitrate = Number(item.bitrate ?? item.bit_rate ?? item.format?.bitrate ?? (preset ? Number(preset) * 1000 : 0)) || 0;
    if (bitrate > 0 && bitrate < 1000) bitrate *= 1000;
    if (!bitrate && codec === 'mp3') bitrate = 128000;
    const rate = Number(item.sample_rate ?? item.sampleRate ?? item.format?.sample_rate) || 44100;
    const hls = protocol === 'hls';
    const score = (codec === requested.codec ? 200 : 0) + (bitrate === requested.bitrate ? 400 : 0) +
      (hls === (requested.codec === 'aac') ? 40 : 0) + bitrate / 1000;
    return {url: item.url, mime, codec, bitrate, rate, hls, score};
  }).filter(Boolean).sort((a,b) => b.score - a.score);
}

export class SoundCloud {
  constructor(host) {
    this.host = host;
    this.account = null;
    this.client = null;
    this.pendingClient = null;
    this.collections = new Map();
    this.songs = new Map();
  }

  async webClient() {
    if (this.client?.expires > Date.now()) return this.client;
    if (!this.pendingClient) this.pendingClient = this.discoverClient();
    try { return await this.pendingClient; } finally { this.pendingClient = null; }
  }

  async discoverClient() {
    const html = await this.host.text(web, {headers: header, timeoutMs: 8000, maxBytes: 2 * 1024 * 1024});
    let {clientId, appVersion} = clientInfo(html);
    if (!clientId) {
      const scripts = [...new Set([...html.matchAll(/https:\/\/[a-z0-9-]+\.sndcdn\.com\/[^"'<>!\s]+\.js/gi)].map(item => item[0]))].reverse();
      for (let offset = 0; !clientId && offset < scripts.length; offset += 4) {
        const results = await Promise.all(scripts.slice(offset, offset + 4).map(url =>
          soft(() => this.host.text(url, {headers: header, timeoutMs: 8000, maxBytes: 8 * 1024 * 1024}), '')));
        for (const source of results) {
          const found = clientInfo(source);
          clientId ||= found.clientId;
          appVersion ||= found.appVersion;
        }
      }
    }
    if (!clientId) throw Error('SoundCloud web client unavailable');
    return this.client = {clientId, appVersion, expires: Date.now() + 12 * 60 * 60 * 1000};
  }

  async request(path, params = {}, token = this.account?.token, retry = true) {
    const url = path.startsWith('/') ? api + path : path;
    if (!apiHosts.includes(httpsHost(url))) throw Error('Invalid SoundCloud API endpoint');
    const client = await this.webClient();
    const endpoint = query(url, {...params, client_id: client.clientId, app_version: client.appVersion,
      app_locale: 'en', oauth_token: null, access_token: null});
    try {
      return await json(this.host, endpoint, {headers: {...header, ...(token ? {Authorization: 'OAuth ' + token} : {})}});
    } catch (error) {
      if (!retry || token || ![401,403].includes(error.status)) throw error;
      if (this.client === client) this.client = null;
      return this.request(path, params, null, false);
    }
  }

  async login(auth) {
    const token = authToken(auth?.values?.token);
    if (!token) return {loggedIn: false};
    const profile = await soft(() => this.request('/me', {}, token));
    if (!scId(profile) || !text(profile?.username)) return {loggedIn: false};
    this.collections.clear();
    this.songs.clear();
    this.account = {token, id: scId(profile), name: text(profile.username)};
    return {loggedIn: true, accountName: this.account.name};
  }

  logout() {
    this.account = null;
    this.collections.clear();
    this.songs.clear();
  }

  track(value) {
    const raw = unwrap(value);
    const item = convertTrack(raw);
    if (item && array(raw?.media?.transcodings).length) putBounded(this.songs, scId(raw), raw);
    return item;
  }

  collection(value, kind) {
    const item = convertCollection(value, [], kind);
    if (item) putBounded(this.collections, item.id, unwrap(value));
    return item;
  }

  trackItems(values) {
    return values.map(raw => {
      const entry = this.track(raw);
      return entry && playable(unwrap(raw)) ? {track: entry} : null;
    }).filter(Boolean);
  }

  collectionItems(values) {
    return values.map(raw => {
      const kind = collectionKind(unwrap(raw));
      const item = this.collection(raw, kind);
      return item ? {[kind]: item} : null;
    }).filter(Boolean);
  }

  async search(request) {
    const term = text(request.query);
    if (!term) return {tracks: []};
    const params = {q: term, limit: bounded(request.limit, 30, 50), linked_partitioning: 1};
    if (permalink(term)) {
      const item = await soft(() => this.request('/resolve', {url: term}));
      if (item?.kind === 'user') return {tracks: [], artists: [convertArtist(item)].filter(Boolean)};
      if (item?.kind === 'playlist') {
        const kind = collectionKind(item);
        return {tracks: [], [kind + 's']: [this.collection(item, kind)].filter(Boolean)};
      }
      return {tracks: this.trackItems([item]).map(value => value.track)};
    }
    const [songs, lists, artists] = await Promise.all(['tracks','playlists','users'].map(kind =>
      soft(() => this.request('/search/' + kind, params))));
    const collections = this.collectionItems(asArray(lists));
    return {tracks: this.trackItems(asArray(songs)).map(item => item.track),
      playlists: collections.flatMap(item => item.playlist ? [item.playlist] : []),
      albums: collections.flatMap(item => item.album ? [item.album] : []),
      artists: asArray(artists).map(value => convertArtist(value)).filter(Boolean)};
  }

  async recommendations(token) {
    for (const path of ['/me/track-recommendations', '/me/suggestions/tracks', '/me/mixed-selections/recommends']) {
      const response = await soft(() => this.request(path, {limit: 24, linked_partitioning: 1}, token));
      const tracks = this.trackItems(asArray(response));
      if (tracks.length) return tracks;
    }
    return [];
  }

  async home() {
    const account = this.account;
    const optional = (path, params = {}, token = account?.token) =>
      soft(() => this.request(path, {limit: 24, linked_partitioning: 1, ...params}, token));
    const [mixed, recommends, stream, system, likes, history, top, trending] = await Promise.all([
      optional('/mixed-selections'), account ? this.recommendations(account.token) : [],
      account ? optional('/me/stream') : null, account ? optional('/system-playlists') : null,
      account ? optional('/users/' + account.id + '/track_likes') : null, account ? optional('/me/play-history/tracks') : null,
      optional('/charts', {kind:'top', genre:'soundcloud:genres:all-music', region:'soundcloud:regions:all-countries'}, null),
      optional('/charts', {kind:'trending', genre:'soundcloud:genres:all-music', region:'soundcloud:regions:all-countries'}, null),
    ]);
    if (this.account !== account) return {shelves: []};
    const shelves = [
      shelf('SoundCloud Recommends', recommends), shelf('Stream', this.trackItems(asArray(stream))),
      shelf('Made for you', this.collectionItems(asArray(system))), shelf('Your likes', this.trackItems(asArray(likes))),
      shelf('Recently played', this.trackItems(asArray(history))), shelf('Top tracks', this.trackItems(asArray(top))),
      shelf('Trending tracks', this.trackItems(asArray(trending))),
      ...asArray(mixed).map(section => {
        const entries = asArray(section.items);
        return shelf(text(section.title ?? section.description), [...this.trackItems(entries), ...this.collectionItems(entries)]);
      }),
    ].filter(section => section.title && section.items.length);
    if (!shelves.length) {
      for (const [name, term] of [['SoundCloud charts', 'SoundCloud Top 50'], ['Discover tracks', 'Fresh Finds']]) {
        const result = await optional('/search/playlists', {q: term}, null);
        const entries = this.collectionItems(asArray(result));
        if (entries.length) shelves.push(shelf(name, entries));
      }
    }
    return {shelves: uniq(shelves, item => item.title)};
  }

  async artist(value) {
    const id = unowned(value, owner).match(/^(?:soundcloud:(?:user|users|artist):)?(\d{1,20})$/)?.[1];
    if (!id) return null;
    const [artist, tracks, collections] = await Promise.all([
      this.request('/users/' + id), soft(() => this.request('/users/' + id + '/tracks', {limit: 50})),
      soft(() => this.request('/users/' + id + '/albums', {limit: 50})),
    ]);
    return convertArtist(artist, this.trackItems(asArray(tracks)).map(t => t.track),
      asArray(collections).map(item => this.collection(item, 'album')).filter(Boolean));
  }

  async collectionDetail(value, kind) {
    const id = unowned(value, owner);
    let info = this.collections.get(id);
    let basePath = null;
    const simpleId = id.match(/^(?:soundcloud:(?:playlist|album):)?(\d{1,20})$/)?.[1];
    if (simpleId) basePath = '/playlists/' + simpleId;
    else if (/^soundcloud:(?:system-playlists|track-stations|selections):[a-z0-9_-]{1,160}$/i.test(id)) {
      const type = id.split(':')[1];
      basePath = '/' + (type === 'selections' ? 'mixed-selections' : type) + '/' + encodeURIComponent(id);
    }
    if (basePath && !array(info?.tracks).length && !asArray(info?.items).length) {
      info = await soft(() => this.request(basePath), info);
    }
    if (!info && permalink(id)) info = await this.request('/resolve', {url: id});
    if (!info) return null;
    let nested = asArray(info.items).find(item => item?.system_playlist)?.system_playlist;
    if (nested && !array(nested.tracks).length && collectionKey(nested)) {
      nested = await this.request('/system-playlists/' + encodeURIComponent(collectionKey(nested)));
      basePath = null;
    }
    info = nested ?? info;
    let entries = array(info.tracks);
    if (!entries.length && basePath) {
      const all = [];
      for (let offset = 0; offset < 10000; offset += 100) {
        const page = asArray(await soft(() => this.request(basePath + '/tracks', {offset, limit: 100})));
        all.push(...page);
        if (page.length < 100) break;
      }
      entries = all;
    }
    const missing = [...new Set(entries.filter(item => !convertTrack(item)).map(scId).filter(Boolean))];
    const full = new Map();
    for (let offset = 0; offset < missing.length; offset += 50) {
      const ids = missing.slice(offset, offset + 50);
      const hydrated = asArray(await soft(() => this.request('/tracks', {ids: ids.join(',')})));
      for (const raw of hydrated) full.set(scId(raw), raw);
    }
    const tracks = this.trackItems(entries.map(item => full.get(scId(item)) ?? item)).map(item => item.track);
    return convertCollection(info, tracks, kind);
  }

  async library(request = {}) {
    const account = this.account;
    if (!account) return {items: [], complete: true};
    const match = text(request.continuation).match(/^([01]):([0-9]{1,4})$/);
    const group = Number(match?.[1] ?? 0), offset = Number(match?.[2] ?? 0);
    if (group === 1 && request.likedSongsOnly) return {items: [], complete: true};
    const path = '/users/' + account.id + (group === 0 ? '/track_likes' : '/playlists');
    const result = await this.request(path, {offset, limit: 50, linked_partitioning: 1}, account.token);
    if (this.account !== account) return {items: [], complete: false};
    const values = asArray(result);
    const items = group === 0 ? this.trackItems(values) : this.collectionItems(values);
    if (group === 0) for (const item of items) item.track.extras.likeStatus = 'LIKE';
    const next = offset + values.length;
    const more = next < 10000 && values.length && Boolean(result.next_href ?? (values.length === 50));
    const continuation = more ? group + ':' + next : !request.likedSongsOnly && group === 0 ? '1:0' : null;
    return {items, continuation, complete: !continuation};
  }

  async audio(request) {
    const explicit = identityKey(request.identity);
    let candidates;
    try {
      if (explicit) {
        candidates = [permalink(explicit) ? await this.request('/resolve', {url: explicit}) :
          this.songs.get(explicit) ?? await this.request('/tracks/' + explicit)];
      } else {
        const expected = await expectation(this.host, request);
        const found = [];
        if (expected.isrc) found.push(...asArray(await this.request('/search/tracks', {q: expected.isrc, limit: 20}))
          .filter(value => convertTrack(value)?.extras.isrc === expected.isrc));
        if (!matches(expected, found, convertTrack).length && expected.title && expected.artist) {
          found.push(...asArray(await this.request('/search/tracks', {q: expected.title + ' ' + expected.artist, limit: 20})));
        }
        candidates = uniq(matches(expected, found, convertTrack), scId).slice(0, 2);
      }
    } catch (error) { return requestFailure(error, 'SoundCloud'); }
    if (!candidates.some(convertTrack)) return failure('NO_MATCH', 'No matching SoundCloud track');
    const quality = request.configuration?.quality ?? await this.host.settings.get('quality');
    let lastError;
    for (let candidate of candidates) {
      if (!convertTrack(candidate) || !playable(candidate)) continue;
      try {
        if (!array(candidate.media?.transcodings).length) candidate = await this.request('/tracks/' + scId(candidate));
        if (!playable(candidate)) continue;
        for (const stream of transcodings(candidate, request.quality, quality).slice(0, 4)) {
          try {
            const result = await this.request(stream.url, {track_authorization: candidate.track_authorization});
            if (!playableHost(result.url)) continue;
            return {stream: {transport: stream.hls ? 'HLS' : 'RANGE_HTTP', locator: result.url,
              mimeType: stream.hls ? 'application/vnd.apple.mpegurl' : stream.mime, codec: stream.codec,
              ...(stream.bitrate ? {bitrate: stream.bitrate} : {}), sampleRate: stream.rate,
              expiresAtMillis: Date.now() + 5 * 60 * 1000, headers: performanceHeaders}};
          } catch (error) { lastError = error; }
        }
      } catch (error) { lastError = error; }
    }
    return lastError ? requestFailure(lastError, 'SoundCloud') : failure('NO_STREAM', 'No full SoundCloud stream is available');
  }
}
