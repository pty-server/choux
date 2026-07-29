# choux

<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="256" alt="Choux application icon: a chocolate-topped cream puff decorated with a terminal prompt" />
</p>

Native desktop client for [ptys](https://github.com/pty-server/ptys) terminal sessions. Built with Tauri v2, Svelte 5, and xterm.js.

Terminal sessions that live on a server so you can attach to them from any device. VT state is server-side, so reconnecting from a different machine is a repaint, not a reconstruction.

**Why “choux”?** *Ptyś* (roughly pronounced “ptySH” in English) is the Polish name for a small cream puff; *choux* is its French pastry family, made from choux pastry. Say it aloud and you get a shell - so naturally it wears a chocolate `>_`.

## Install

> Packages are published from v0.1.0 onwards. Until that release lands, build from source - see [Development prerequisites](#development-prerequisites).

### macOS (Apple Silicon)

```bash
brew install --cask pty-server/tap/choux
```

Apple Silicon only. Intel Macs get an architecture error from Homebrew instead of a download. The Cask installs a signed and notarized build, so Gatekeeper does not prompt.

### Linux

Download the `.deb` or `.AppImage` from [Releases](https://github.com/pty-server/choux/releases).

## Platform targets

| Platform | Architecture | Format |
|----------|--------------|--------|
| Linux | x86_64 | `.deb`, `.AppImage` |
| macOS | arm64 | `.dmg` (signed, notarized) |

Windows is not yet supported - local ptys discovery uses a Unix control socket.

## Development prerequisites

- **Rust toolchain** (for Tauri)
- **Node.js >= 24**
- **Linux:** `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `build-essential`, `curl`, `wget`, `file`, `libxdo-dev`, `libssl-dev`

## Ptys dependency note

`@pty-server/protocol` and `@pty-server/ptys` (devDependency) come from npm, both pinned to the `next` dist-tag while ptys is in prerelease. `npm install` is all the setup a fresh clone needs; the pinned versions are recorded in `package-lock.json`. Move them to a stable semver range once ptys publishes a non-prerelease release.

## Dev loop

```bash
npm install
npm run tauri:dev
```

## Build

```bash
npm run tauri:build   # production Tauri binary
npm run build         # plain Vite build (e.g. browser-only target)
```

## Tests

```bash
npm test                   # vitest unit tests
npm run lint               # eslint
npm run typecheck          # tsc --noEmit
npm run test:integration   # integration tests against a real ptys server
```

`npm test`, `npm run lint` and `npm run typecheck` are the CI gates. The integration suite is not run in CI: it spawns a real ptys server from a local ptys checkout, so it only runs when one is present and built.

## Supported custom events

Applications running inside Ptys sessions can ask Choux to handle selected custom events. See [Supported custom events](docs/supported-events.md) for the `ptys.question` request format and response envelopes.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Karol Nowacki.

### Bundled font

Choux ships LiterationMono Nerd Font Mono (`src/assets/fonts/*.woff2`), the [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) patched build of [Liberation Mono](https://github.com/liberationfonts/liberation-fonts). Copyright (c) 2012 Red Hat, Inc., licensed under the SIL Open Font License 1.1. The full license text ships with the application at `licenses/LiterationMonoNerdFont-OFL.txt` and is in this repo at [public/licenses/LiterationMonoNerdFont-OFL.txt](public/licenses/LiterationMonoNerdFont-OFL.txt).