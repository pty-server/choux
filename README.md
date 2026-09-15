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

Release candidates track prereleases on a separate channel:

```bash
brew install --cask pty-server/tap/choux@rc
```

Apple Silicon only. Intel Macs get an architecture error from Homebrew instead of a download. Both Casks install a signed and notarized build, so Gatekeeper does not prompt. They install the same app and therefore conflict - uninstall one before installing the other.

### Linux

Download the `.deb` or `.AppImage` from [Releases](https://github.com/pty-server/choux/releases).

### Updates

Choux checks GitHub Releases on launch and every 12 hours. When a new version is out, the top bar offers to install it and restart, and Settings has a manual check. Nothing downloads until you click. A `.deb` install asks for your password, because the package installs as root.

## Connecting to ptys

Choux reaches a ptys server in one of three ways, managed under **Manage servers**:

- **Local.** On launch the desktop app finds the ptys daemons running as your user and connects through each daemon's private Unix control socket, with no token. If none is running, Choux offers to install and start ptys.
- **URL.** Any ptys server listening on HTTP(S), with its bearer token, or without one for a server started with authentication disabled. This is the only option in the browser build.
- **SSH** (desktop app only). Choux runs `ssh <host> ptys bridge --instance <name>` and talks to the remote daemon through that pipe, so nothing has to listen on the network and no token is needed. The remote host needs ptys 0.3.0 or newer with its daemon running, and key or agent authentication with a known host key: ssh runs non-interactively, so password and host-key prompts cannot be answered. When `ptys` is not on the remote non-interactive `PATH`, as with nvm, set the node bin directory, for example `/home/me/.nvm/versions/node/v24.21.0/bin`.

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

`@pty-server/protocol` and `@pty-server/ptys` (devDependency) come from npm, both on `^0.3.0`. `npm install` is all the setup a fresh clone needs; the resolved versions are recorded in `package-lock.json`. A caret on a `0.x` version locks the minor, so each new ptys minor release needs an explicit bump here.

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

Applications running inside Ptys sessions can ask Choux to handle selected custom events. See [Supported custom events](docs/supported-events.md) for the `choux.question` request format and response envelopes.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Karol Nowacki.

### Bundled font

Choux ships LiterationMono Nerd Font Mono (`src/assets/fonts/*.woff2`), the [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) patched build of [Liberation Mono](https://github.com/liberationfonts/liberation-fonts). Copyright (c) 2012 Red Hat, Inc., licensed under the SIL Open Font License 1.1. The full license text ships with the application at `licenses/LiterationMonoNerdFont-OFL.txt` and is in this repo at [public/licenses/LiterationMonoNerdFont-OFL.txt](public/licenses/LiterationMonoNerdFont-OFL.txt).