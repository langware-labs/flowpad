# Flowpad

A local-first AI development environment powered by Claude Code. Run AI-assisted workflows directly on your machine with full control over your data.

## Install

### Desktop App (recommended)

Download the latest release for your platform:

| Platform | Download |
|----------|----------|
| **macOS (Apple Silicon)** | [Flowpad-arm64.dmg](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-arm64.dmg) |
| **macOS (Intel)** | [Flowpad-x64.dmg](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-x64.dmg) |
| **Windows** | [Flowpad Setup.exe](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad%20Setup.exe) |
| **Linux (AppImage)** | [Flowpad-x64.AppImage](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-x64.AppImage) |
| **Linux (deb)** | [Flowpad-x64.deb](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-x64.deb) |
| **Linux (rpm)** | [Flowpad-x64.rpm](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-x64.rpm) |

The desktop app handles everything automatically — no Python or other dependencies required. On first launch it installs the backend from PyPI and starts it for you.

#### Linux AppImage

```bash
chmod +x Flowpad-x64.AppImage
./Flowpad-x64.AppImage
```

---

### Python Package (CLI)

Install Flowpad as a command-line tool. Requires **Python 3.10+**.

#### Using uv (recommended)

```bash
# Install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install flowpad
uv tool install flowpad

# Start the server
flow start
```

#### Using pipx

```bash
# Install pipx if you don't have it
python3 -m pip install --user pipx

# Install flowpad
pipx install flowpad

# Start the server
flow start
```

This starts the Flowpad server at [http://localhost:9007](http://localhost:9007) and opens it in your browser.

#### CLI Commands

```
flow start     Start the server (background, with auto-restart)
flow stop      Stop the server
flow status    Show server status
flow setup     Interactive first-time setup
```

#### Upgrade

```bash
# Using uv
uv tool upgrade flowpad

# Using pipx
pipx upgrade flowpad
```

---

## Requirements

| Install method | Requirements |
|----------------|-------------|
| **Desktop app** | None (self-contained) |
| **Python package** | Python 3.10+ |

Both methods require an internet connection on first launch to download dependencies.

## License

Copyright (c) 2024 Langware Labs. All rights reserved.
