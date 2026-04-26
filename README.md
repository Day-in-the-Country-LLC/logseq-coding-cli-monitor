# Coding CLI Monitor for Logseq

Monitor wrapped coding CLI sessions from Logseq and surface whether they are working or need attention.

The plugin adds a dock inside Logseq plus a movable setup/status panel from the `/CLI Monitor` command. A small local helper watches wrapped CLI sessions and exposes status to the plugin at `http://127.0.0.1:31274/status`.

## Features

- Shows active wrapped `codex`, `claude`, and `opencode` sessions in Logseq.
- Uses `working` and `attention` status only.
- Highlights attention states in yellow and working states in green.
- Hides finished sessions from the active monitor.
- Adds manual refresh feedback and auto-refreshes every 5 seconds.
- Provides a movable setup panel through `/CLI Monitor`.

## Requirements

- Logseq desktop.
- Node.js available on your machine.
- macOS for the current helper notifications.
- One or more supported CLIs: `codex`, `claude`, or `opencode`.

No Homebrew install is required for the Logseq plugin itself. Homebrew may be useful later if the helper is packaged as a standalone command, but this version can run directly with Node.

## Helper Usage

Start the local daemon:

```sh
node ~/.logseq/plugins/logseq-coding-cli-monitor/helper/cli-monitor.mjs daemon
```

Run a wrapped coding CLI session:

```sh
node ~/.logseq/plugins/logseq-coding-cli-monitor/helper/cli-monitor.mjs run --name "Issue 42" codex
```

Check status from a terminal:

```sh
node ~/.logseq/plugins/logseq-coding-cli-monitor/helper/cli-monitor.mjs status
```

For shorter commands from a local checkout, run:

```sh
npm link
cli-monitor daemon
cli-monitor run --name "Issue 42" codex
```

## Logseq Commands

- `/CLI Monitor` opens the movable monitor panel.
- `/CLI Monitor Setup` shows the daemon startup command.

## Marketplace Packaging

The plugin is designed to ship as a no-build package. The release archive should include:

- `index.html`
- `main.js`
- `icon.svg`
- `package.json`
- `README.md`
- `LICENSE`
- `helper/cli-monitor.mjs`
- `vendor/lsplugin.user.js`

Do not include `.git`, generated macOS files, or local monitor state.
