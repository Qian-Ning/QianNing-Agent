---
title: Installation and updates
description: Choose, install, update, and remove the correct QianNing Agent package on Windows, macOS, or Linux.
---

# Installation and updates

Official packages are published on [GitHub Releases](https://github.com/Qian-Ning/QianNing-Agent/releases/latest). Download from that page so the filename, version, architecture, and published checksums stay together.

## Choose a package

| Platform | Package | Update behavior |
|---|---|---|
| Windows x64 | `QianNing-Agent-Setup-<version>.exe` | NSIS installation supports the in-app update lane |
| Windows x64 | `QianNing-Agent-Portable-<version>.exe` or portable ZIP | Portable builds notify and open the release page; replace them manually |
| macOS arm64 / x64 | `QianNing-Agent-<version>-<arch>.dmg` | Signed and notarized release builds support in-app updates |
| Linux x64 | AppImage | Supports the in-app update lane |
| Debian / Ubuntu x64 | `qianning-agent_<version>_amd64.deb` | The app announces a release and opens the download page |
| Fedora / RPM x64 | `qianning-agent-<version>-x86_64.rpm` | The app announces a release and opens the download page |

QianNing Agent publishes native macOS arm64 and x64 packages, Windows x64 packages, and Linux x64 packages. Linux release qualification targets glibc 2.35 or newer, including Ubuntu 22.04, Debian 12, and Fedora 36 or newer.

## Windows

1. Download the NSIS installer for the normal installed experience.
2. Run the installer and choose the installation directory when prompted.
3. Launch **QianNing Agent** from the Start menu or desktop shortcut.
4. Keep the portable build only when you need a self-contained application folder and accept manual updates.

Windows may show a trust dialog when publisher reputation has not accumulated. Check that the file came from the official release page before continuing.

## macOS

1. Download the DMG matching the Mac architecture: `arm64` for Apple Silicon, `x64` for Intel.
2. Open the DMG and drag **QianNing Agent** into Applications.
3. Start it from Applications.

Tag releases use Developer ID signing, notarization, and stapling. Do not use commands that remove quarantine for an unsigned file obtained elsewhere.

## Linux

### AppImage

```bash
chmod +x QianNing-Agent-<version>-x86_64.AppImage
./QianNing-Agent-<version>-x86_64.AppImage
```

### Debian or Ubuntu

```bash
sudo apt install ./qianning-agent_<version>_amd64.deb
```

### Fedora or another RPM system

```bash
sudo dnf install ./qianning-agent-<version>-x86_64.rpm
```

The executable name installed by Linux packages is `qianning-agent`.

## First launch

QianNing Agent starts a packaged Rust host process named `QianNing-Agent-Host-Core` and a bundled Node agent runtime. If the startup screen reports a host or runtime failure:

1. restart the application once;
2. open the log location offered by the error screen;
3. record the application version, operating system, and failing process;
4. attach redacted logs to a GitHub issue.

Do not post provider keys, connection strings, private project paths, or complete environment dumps.

## Updates

The application checks a fixed HTTPS GitHub Releases feed. The renderer cannot replace the feed URL. Supported installer lanes download a hash-bound artifact and offer restart-to-install. Manual lanes open the official release page.

An unavailable feed, invalid manifest, hash mismatch, or unsupported package state fails closed and does not install an update.

## Data during upgrade or removal

Application data is separate from the installation directory:

- packaged builds: `~/.qianning-agent`
- development builds: `~/.qianning-agent-dev`

Installing a newer version keeps this directory and runs supported database migrations. Removing the application does not necessarily remove user data. Back up or delete the data directory separately according to [Data, privacy, and security](/guide/data-and-security).

## Next step

Continue with [Your first project session](/guide/first-session).
