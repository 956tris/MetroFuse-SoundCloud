import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const at = (_name, file) => new URL('../plugin/' + file, import.meta.url);
const {SoundCloud} = await import(at('soundcloud', 'soundcloud.js'));
const isrc = 'USAAA1234567';
const result = (body, status = 200) => ({status, body: JSON.stringify(body)});
const webToken = 'test-web-access-token-not-a-real-token';
const scTrack = {id: 25, kind: 'track', title: 'One', user: {id: 5, username: 'Artist'},
  full_duration: 180000, publisher_metadata: {isrc, album_title: 'Album'},
  permalink_url: 'https://soundcloud.com/artist/one', track_authorization: 'playback-proof',
  media: {transcodings: [
    {url: 'https://api-v2.soundcloud.com/media/mp3', preset: 'mp3_128', format: {mime_type: 'audio/mpeg', protocol: 'progressive'}},
    {url: 'https://api-v2.soundcloud.com/media/aac', preset: 'aac_160', format: {mime_type: 'audio/aac', protocol: 'hls'}},
    {url: 'https://unrelated.example/media', preset: 'aac_160', format: {mime_type: 'audio/aac', protocol: 'hls'}},
  ]},
};

function mock(callback, settings = {}, track = null) {
  return {http: request => callback(new URL(request.url), request),
    text: async url => url.endsWith('.js') ? 'client_id:"fixtureclientid0123456789"' :
      '<script src="https://a-v2.sndcdn.com/assets/fixture.js"></script>',
    settings: {get: async key => settings[key]}, track: async () => track, log() {}};
}

test('each API 1.2.0 entry point registers audio, catalog, search, Home and secret login', async () => {
  let spec;
  globalThis.definePlugin = value => { spec = value; };
  for (const name of ['soundcloud']) {
    const manifest = JSON.parse(await readFile(at(name, 'manifest.json'), 'utf8'));
    assert.equal(manifest.api, '1.2.0');
    assert.equal(manifest.id, 'metrofuse.' + name);
    assert.deepEqual(manifest.platforms, ['desktop','android']);
    await import(at(name, 'index.js'));
    let login;
    spec.setup({...mock(() => result({})), login: callbacks => { login = callbacks; }});
    assert.equal((await login.request()).fields[0].secret, true);
    assert.equal(typeof spec.catalog[manifest.id + '.catalog'].library, 'function');
    assert.equal(typeof spec.search[manifest.id + '.search'], 'function');
    assert.equal(typeof spec.home, 'function');
    assert.ok(spec.audioSources[manifest.id + '.audio'].capabilities.transports.includes('HLS'));
    spec.dispose();
  }
  delete globalThis.definePlugin;
});

test('SoundCloud discovers its web client, maps ISRC and resolves an HLS transcoding', async () => {
  const urls = [];
  const provider = new SoundCloud(mock((url, request) => {
    urls.push(url.pathname);
    assert.equal(url.hostname, 'api-v2.soundcloud.com');
    assert.equal(url.searchParams.get('client_id'), 'fixtureclientid0123456789');
    if (url.pathname === '/search/users') return result({collection: [scTrack.user]});
    if (url.pathname === '/search/playlists') return result({collection: []});
    if (url.pathname === '/search/tracks') return result({collection: [scTrack]});
    assert.equal(url.pathname, '/media/aac');
    assert.equal(url.searchParams.get('track_authorization'), 'playback-proof');
    assert.equal(request.headers.Authorization, undefined);
    return result({url: 'https://audio.sndcdn.com/fixture.m3u8'});
  }, {quality: 'AAC_160'}));
  const search = await provider.search({query: 'One'});
  assert.equal(search.tracks[0].extras.isrc, isrc);
  assert.equal(search.tracks[0].artist, 'Artist');
  assert.equal(search.tracks[0].duration, 180000);
  const {stream} = await provider.audio({identity: {canonicalId: 'metrofuse:metrofuse.soundcloud:' + search.tracks[0].id}});
  assert.equal(stream.transport, 'HLS');
  assert.equal(stream.codec, 'aac');
  assert.equal(stream.bitrate, 160000);
  assert.ok(!urls.includes('/media/mp3'));
});

test('SoundCloud verifies the OAuth session before fetching likes and rejects previews', async () => {
  const provider = new SoundCloud(mock((url, request) => {
    if (url.pathname === '/me') {
      assert.equal(request.headers.Authorization, 'OAuth ' + webToken);
      return result({id: 11, username: 'Account'});
    }
    if (url.pathname.endsWith('/track_likes')) return result({collection: [{track: scTrack}]});
    if (url.pathname === '/tracks/26') return result({...scTrack, id: 26, policy: 'SNIP'});
    assert.fail('Unexpected request ' + url.pathname);
  }));
  assert.equal((await provider.login({values: {token: 'oauth_token=' + webToken}})).loggedIn, true);
  const likes = await provider.library({likedSongsOnly: true});
  assert.equal(likes.items[0].track.extras.likeStatus, 'LIKE');
  assert.equal((await provider.audio({identity: {canonicalId: 'soundcloud:track:26'}})).error.code, 'NO_STREAM');
  provider.logout();
  assert.equal((await provider.library()).items.length, 0);
});

test('SoundCloud personalized Home uses the OAuth session and the legacy recommendation fallback', async () => {
  const paths = [];
  const provider = new SoundCloud(mock((url, request) => {
    const path = url.pathname;
    paths.push(path);
    if (path === '/charts') assert.equal(request.headers.Authorization, undefined);
    else assert.equal(request.headers.Authorization, 'OAuth ' + webToken);
    if (path === '/me') return result({id: 11, username: 'Account'});
    if (path === '/me/track-recommendations') return result({collection: []});
    if (path === '/me/suggestions/tracks') return result({collection: [scTrack]});
    return result({collection: []});
  }));
  assert.equal((await provider.login({values: {token: webToken}})).loggedIn, true);
  const home = await provider.home();
  assert.equal(home.shelves.find(shelf => shelf.title === 'SoundCloud Recommends').items[0].track.id, 'soundcloud:track:25');
  assert.ok(paths.includes('/me/track-recommendations') && paths.includes('/me/suggestions/tracks'));
  assert.ok(!paths.includes('/me/mixed-selections/recommends'));
});

test('SoundCloud reloads a cached playlist summary and resolves its ID-only entries in order', async () => {
  const list = {id: 10, kind: 'playlist', title: 'Playlist', user: scTrack.user};
  const provider = new SoundCloud(mock(url => {
    if (url.pathname === '/search/playlists') return result({collection: [list]});
    if (url.pathname.startsWith('/search/')) return result({collection: []});
    if (url.pathname === '/playlists/10') return result({...list, tracks: [scTrack, {id: 26}, scTrack]});
    assert.equal(url.pathname, '/tracks');
    assert.equal(url.searchParams.get('ids'), '26');
    return result([{...scTrack, id: 26, title: 'Two'}]);
  }));
  const playlist = (await provider.search({query: 'Playlist'})).playlists[0];
  const detail = await provider.collectionDetail(playlist.id, 'playlist');
  assert.deepEqual(detail.tracks.map(value => value.title), ['One', 'Two', 'One']);
});
