# Rivetdeck

English | [中文](README.zh.md)

Rivetdeck packages [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a native desktop application for macOS, Windows, and Linux. It keeps the upstream Web application, agent runtime, profiles, and workspace workflow while providing an operating-system window and desktop installers.

<a id="status"></a>

## Status

This project and its upstream runtime are in developer preview.

### Maintenance outlook

Upstream [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) now ships a first-party Desktop application in its monorepo with foundational functionality. This Electron distribution may therefore stop receiving regular updates and move to an **archived** maintenance posture. The capability it still uniquely provides is first-class Electron desktop integration (`ctx.desktop`) for portable plugins—upstream Desktop does not expose this surface today.

The standalone plugin repositories may continue to receive occasional updates; version bumps will be slow and irregular.

## Install

Download the installer for your platform from the [latest release](https://github.com/cherrchen/deepseek-harness-electron/releases/latest):

- macOS: DMG or ZIP for Apple Silicon and Intel Macs
- Windows: NSIS installer for x64 and ARM64
- Linux: AppImage or DEB package for x64 and ARM64

Open the installed application and complete the provider setup in the Harness UI before starting an agent session.

<a id="run"></a><a id="run-from-source"></a>

## Run from source

Install a supported Node.js version (`^22.19.0` or `>=24`) and pnpm, then build the Harness runtime and start Electron:

```sh
git clone https://github.com/cherrchen/deepseek-harness-electron.git
cd deepseek-harness-electron
pnpm install
pnpm run build
pnpm --filter @dsh-electron/dsh-electron start
```

## Runtime and data

Electron starts DeepSeek Harness on a random `127.0.0.1` port and opens its ready URL in a sandboxed window. The renderer has no Node.js integration, uses context isolation and Chromium sandboxing, and opens requested HTTP and HTTPS links in the system browser.

Harness profiles and state live in the platform-specific application-data directory. Agent shell commands start in the current user's home directory; select another workspace from the Harness UI when needed.

## Bundled plugins

Rivetdeck preinstalls two portable DSH ecosystem bundles published from standalone repositories. Both appear in the web profile's Installed plugins and can be enabled or disabled there.

| Plugin | Desktop role | Summary |
|---|---|---|
| [dsh-theme-studio](https://github.com/cherrchen/dsh-theme-studio) | Preinstalled ecosystem plugin | Color themes under **Settings → General → Themes**, alongside official Light / Dark / System Appearance. Listed in `dshElectron.ecosystemPlugins`. |
| [dsh-plugin-git](https://github.com/cherrchen/dsh-plugin-git) | Preinstalled ecosystem plugin | Local Git status, diffs, staging, commits, and branch controls in the right sidebar. Listed in `dshElectron.ecosystemPlugins`. |

Canonical development happens in those repositories; this monorepo installs their published npm packages and keeps no copy of their source.

## Related plugin

[dsh-plugin-multi-root-workspace](https://github.com/cherrchen/dsh-plugin-multi-root-workspace) extends a DSH workspace with additional folders. It is an independently installed plugin and is not bundled with this Desktop release.

## Development

Run the desktop application's focused checks with:

```sh
pnpm --filter @dsh-electron/dsh-electron test
pnpm --filter @dsh-electron/dsh-electron build
```

See the [desktop application guide](apps/electron/README.md), [development guide](docs/development.md), and [architecture documentation](docs/architecture.md) for repository details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This fork follows upstream DeepSeek Harness development while maintaining its desktop packaging.

## License

[MIT](LICENSE). Third-party dependency notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
