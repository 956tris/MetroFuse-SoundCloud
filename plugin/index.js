import {SoundCloud} from './soundcloud.js';

const browser = {
  url: 'https://soundcloud.com/signin',
  cookieUrl: 'https://soundcloud.com/',
  cookieField: 'token',
  requiredCookies: ['oauth_token', 'oauth-token', 'soundcloud_oauth_token', 'access_token'],
  allowedHosts: ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'secure.soundcloud.com', 'api-auth.soundcloud.com',
    'accounts.google.com', 'appleid.apple.com', 'www.facebook.com', 'm.facebook.com'],
};
const labels = {
  title: 'Sign in to SoundCloud',
  hint: 'Sign in to SoundCloud to load your personal Home feed and library.',
  error: 'SoundCloud could not verify this session. Finish signing in or try again.',
  retry: 'Retry', cancel: 'Cancel', login: 'Sign in', logout: 'Sign out',
};

let provider;
definePlugin({
  setup(host) {
    provider = new SoundCloud(host);
    host.login({
      request: async () => ({
        fields: [{id: 'token', label: 'SoundCloud OAuth token', secret: true}],
        instructions: labels.hint,
      }),
      web: async () => browser,
      ui: async () => ({request: browser, labels}),
      login: credentials => provider.login(credentials),
      logout: () => provider.logout(),
    });
  },
  dispose() { provider?.logout(); },
  search: {'metrofuse.soundcloud.search': request => provider.search(request)},
  audioSources: {
    'metrofuse.soundcloud.audio': {
      capabilities: {transports: ['DIRECT', 'RANGE_HTTP', 'HLS'], codecs: ["aac","mp3","opus"], formats: ["m4a","mp3","hls","ogg"]},
      resolve: request => provider.audio(request),
    },
  },
  catalog: {
    'metrofuse.soundcloud.catalog': {
      album: id => provider.collectionDetail(id, 'album'),
      artist: id => provider.artist(id),
      playlist: id => provider.collectionDetail(id, 'playlist'),
      library: request => provider.library(request),
      supportsLikedSongs: true,
    },
  },
  home: () => provider.home(),
});
