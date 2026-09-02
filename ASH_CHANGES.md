# Ash changes relative to Tabby

## Git baseline

- Upstream repository: Tabby
- Upstream branch: `master`
- Upstream tag: `v1.0.235`
- Baseline commit: `14e2d60b` (`skipLibCheck`)
- Ash development branch: `ash`

Everything not listed below remains the original Tabby `v1.0.235` source. Git
is the source of truth: `git diff v1.0.235...ash` shows the complete Ash delta.

## New Ash-owned code

### Built-in AI module

The entire `tabby-ai/` directory is new Ash code. It contains:

- AI configuration and its editable default YAML policy;
- OpenAI-compatible streaming chat client;
- per-terminal-tab agent context and permanent JSONL session storage;
- natural-language detection plus the forced-AI `Shift+Enter` shortcut;
- command approval, automatic approval, blocking and secret redaction;
- serialized command execution and the per-SSH-tab busy lock;
- inline AI blocks embedded between normal SSH terminal output;
- AI settings UI, Save and Restart controls.

### Reproducible Windows workflow

These files are new Ash maintenance code:

- `scripts/.bin/yarn.cmd`
- `scripts/ash-install-dependencies.ps1`
- `scripts/ash-build.ps1`
- `scripts/ash-start.ps1`
- `scripts/ash-package-windows-x64.ps1`

The packaging script produces an unsigned Windows x64 portable ZIP and handles
the Electron mirrors and the non-administrator `winCodeSign` extraction case.

## Original Tabby files modified for Ash

### Registering and building the built-in module

- `scripts/vars.mjs`: registers `tabby-ai` as a built-in plugin.
- `app/package.json`: declares `tabby-ai` as an application peer.
- `webpack.plugin.config.mjs`: permits the legacy `ansi-color` dependency used
  by the AI terminal rendering path.
- `package.json` and `yarn.lock`: pin a registry-installable Electron node-gyp
  release for reproducible Windows dependency resolution.
- `scripts/build-windows.mjs`: emits only the portable ZIP, not NSIS.

### Portable data and restart behavior

- `app/lib/portable.ts`: packaged Windows builds always create and use `data/`
  beside the executable; also exposes the portable environment contract used
  by updater and relaunch services.
- `tabby-electron/src/services/hostApp.service.ts`: makes Restart work in both
  the portable package and source development mode.

### AI integration with terminal and SSH lifecycle

- `tabby-terminal/src/api/baseTerminalTab.component.ts`: adds the stable AI
  session identifier to a terminal tab.
- `tabby-terminal/src/api/connectableTerminalTab.component.ts`: persists that
  identifier in recovery state.
- `tabby-ssh/src/recoveryProvider.ts`: restores it with an SSH tab.
- `tabby-terminal/src/frontends/frontend.ts`: exposes terminal key events.
- `tabby-terminal/src/frontends/xtermFrontend.ts`: supports terminal-anchored
  inline blocks and lets `tabby-ai` consume `Shift+Enter`.

### Optional native-module fallbacks

The following original files were made tolerant of optional Windows native
bindings that are unavailable without Visual Studio Build Tools:

- `app/lib/app.ts`
- `app/lib/window.ts`
- `app/src/plugins.ts`
- `tabby-electron/src/pty.ts`
- `tabby-electron/src/services/platform.service.ts`
- `tabby-local/src/environment.ts`

These fallbacks preserve core terminal and SSH behavior. Missing integrations
only disable their related optional feature: registry discovery, legacy blur,
native font enumeration or process-tree inspection.

## Files deliberately excluded from Git

`.gitignore` excludes the following generated or private state:

- `/.build-cache/`: downloaded build tools and package caches;
- `/data/`: source-run settings, AI API configuration and permanent sessions;
- `dist/` and `*/dist/`: packaged and compiled output;
- `builtin-plugins/`: temporary packaging assembly;
- all `node_modules/` and generated typings.

The portable ZIP starts without a bundled `data/` directory. Each extracted
copy creates its own `data/` beside `Tabby.exe` on first launch.

## Useful Git comparisons

```powershell
# Complete Ash change list
git diff --stat v1.0.235...ash

# Only files inherited from Tabby and modified by Ash
git diff --name-status --diff-filter=M v1.0.235...ash

# Only files added by Ash
git diff --name-status --diff-filter=A v1.0.235...ash
```
