import {SoundCloud} from './soundcloud.js';

let provider;
definePlugin({
  setup(host) {
    provider = new SoundCloud(host);
    host.login({
      request: async () => ({
        fields: [{id: 'token', label: 'SoundCloud OAuth token', secret: true}],
        instructions: 'Enter your SoundCloud OAuth token or a cookie containing oauth_token.',
      }),
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
