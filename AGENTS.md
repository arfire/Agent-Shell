# Repository Guidelines

## Project Structure & Module Organization

Ash is an Electron application with an Angular/TypeScript frontend. `app/` contains the Electron shell and renderer entry points. Most features live in first-party plugins named `tabby-*`; each plugin keeps TypeScript in `src/`, build settings in `webpack.config.mjs`, and package metadata in `package.json`. For example, terminal UI belongs in `tabby-terminal/`, SSH support in `tabby-ssh/`, and AI behavior in `tabby-ai/`. Shared translations are under `locale/`, web entry points under `web/` and `tabby-web-demo/`, maintenance tooling under `scripts/`, and documentation assets under `docs/`. Treat `dist/`, `app/dist/`, and plugin `dist/` directories as generated output.

## Build, Test, and Development Commands

Use Node.js 22 and Yarn 1.x. On Windows, the repository-specific wrappers are preferred:

- `./scripts/ash-install-dependencies.ps1` installs pinned dependencies and Electron.
- `./scripts/ash-build.ps1` compiles the app and all built-in plugins.
- `./scripts/ash-start.ps1` launches the compiled app from source.
- `./scripts/ash-package-windows-x64.ps1` creates a portable ZIP in `dist/`.

Cross-platform equivalents are `yarn`, `yarn build`, `yarn start`, and `yarn watch`. Run `yarn lint` for TypeScript linting and `yarn build:typings` when changing exported plugin APIs.

## Coding Style & Naming Conventions

Follow `.editorconfig`: LF endings, final newline, four spaces for TypeScript, Pug, and SCSS, and two spaces for JSON/YAML. ESLint requires single quotes, no semicolons, multiline trailing commas, strict equality, and no unused variables. Use Angular-style suffixes such as `foo.component.ts`, `foo.service.ts`, and `foo.directive.ts`; keep matching `.pug` and `.scss` files beside the component. Prefer focused changes within the owning plugin and expose cross-plugin contracts through its API module.

## Testing Guidelines

There is currently no automated test command or coverage threshold. Before submitting, run `yarn lint` and `yarn build`, then exercise the affected flow with `./scripts/ash-start.ps1`. Document platforms and manual scenarios tested. If introducing tests, use colocated `*.spec.ts` files and add a repeatable package script.

## Commit & Pull Request Guidelines

Recent history uses short Conventional Commit prefixes: `feat:`, `fix:`, `refactor:`, `docs:`, and `chore:`. Write imperative, narrowly scoped subjects. Pull requests should explain the problem and solution, link relevant issues, list validation steps and platforms, and include screenshots or recordings for UI changes. Keep generated artifacts and unrelated formatting out of commits.
