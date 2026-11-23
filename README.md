# MetroFuse SoundCloud

SoundCloud for **MetroFuse 10.0.0 Stable** on Android and desktop, targeting Plugin API 1.2.0. Download the MFP from [GitHub Releases](https://github.com/956tris/MetroFuse-SoundCloud/releases/latest) and import it in the MetroFuse Plugins screen.

**Account and recommendations.** Open the SoundCloud account screen in MetroFuse and sign in through the built-in WebView. The plugin verifies the captured session before MetroFuse saves it in its credential store. Signed-in Home includes recommendations, stream, likes, and recent plays where SoundCloud exposes them.

**Playback.** Public tracks with a compatible stream can play without signing in. The plugin discovers SoundCloud's web client ID and resolves HLS or progressive streams through API v2. SoundCloud tracks that only offer protected stream formats require playback in a client that supports those formats.

## Build

Run `python tooling/build.py --test` with Python 3.11 or newer and Node.js 20 or newer. The build runs the provider fixtures, stages the GPL license, then packages and verifies the MFP with the bundled MetroFuse SDK toolkit. The package and SHA-256 checksum are in `dist/`. Actions publishes the version recorded in the manifest from `main`.

The provider methods are based on the original [MetroFuse Android source at 5ba186773](https://github.com/956tris/MetroFuse/tree/5ba186773). The self-contained build uses the MetroFuse 1.2.0 toolkit. See [LICENSE](LICENSE).
