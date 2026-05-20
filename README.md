---
id: 4a1f6926-a591-55ab-94d7-5abbfdd3d6db
---

# Flowpad

A local-first AI development environment powered by Claude Code. Run AI-assisted workflows directly on your machine with full control over your data.

## Install

### Desktop App (recommended)

Download the latest release for your platform:

| Platform | Download                                                                                                          |
|----------|-------------------------------------------------------------------------------------------------------------------|
| **macOS (Apple Silicon)** | [Flowpad-arm64.dmg](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-arm64.dmg)          |
| **macOS (Intel)** | [Flowpad-x64.dmg](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-x64.dmg)              |
| **Windows** | [Flowpad-Setup.exe](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-Setup.exe)          |
| **Linux (AppImage)** | [Flowpad-x64.AppImage](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-x86_64.AppImage) |
| **Linux (deb)** | [Flowpad-x64.deb](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-amd64.deb)            |
| **Linux (rpm)** | [Flowpad-x64.rpm](https://github.com/langware-labs/flowpad/releases/latest/download/Flowpad-x86_64.rpm)           |

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

#### Using pip

```bash
pip install flowpad

# Install a specific version
pip install flowpad==0.2.0
```

This starts the Flowpad server at [http://localhost:9007](http://localhost:9007) and opens it in your browser.

#### Upgrade

```bash
# Using uv
uv tool upgrade flowpad

# Using pipx
pipx upgrade flowpad

# Using pip
pip install --upgrade flowpad
```

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `flow` | Print version |
| `flow start` | Start the server (background, with auto-restart) |
| `flow stop` | Stop the server |
| `flow status` | Show server status |
| `flow setup <agent>` | Setup Flowpad for a coding agent (e.g. `claude-code`) |
| `flow trace` | Start server and trace hook events in real-time |
| `flow hooks set` | Install Flow hooks into Claude Code settings |
| `flow hooks list` | List configured hooks |
| `flow hooks clear` | Remove Flow hooks from Claude Code settings |
| `flow config list` | List configuration values |
| `flow config set key=value` | Set a configuration value |
| `flow auth login` | Login to Flowpad (opens browser or accepts API key) |
| `flow auth logout` | Logout and remove stored credentials |
| `flow ping <string>` | Send a test ping to the local server |

## Uninstall

```bash
# Using uv
uv tool uninstall flowpad

# Using pipx
pipx uninstall flowpad

# Using pip
pip uninstall flowpad
```

## Requirements

| Install method | Requirements |
|----------------|-------------|
| **Desktop app** | None (self-contained) |
| **Python package** | Python 3.10+ |

Both methods require an internet connection on first launch to download dependencies.

## Contributing

Flowpad is open source. To set up a local development environment, run the tests, or build the package, see [docs/contributing.md](docs/contributing.md).

## License

Copyright (c) 2024 Langware Labs. All rights reserved.
