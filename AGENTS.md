# BioCN — Agent Guidelines

## Project

Cross-platform desktop app: Tauri 2 (Rust, `src-tauri/`) + React 19 + TypeScript + Vite (`src/`).

## UI rules (mandatory)

- **This is a cross-platform desktop application.**
- **The frontend is built with daisyUI. You must NOT write UI components yourself.**
  Use daisyUI's existing component classes (e.g. `btn`, `card`, `input`, `modal`, `navbar`,
  `menu`, `dropdown`, `table`, `tabs`, `alert`, `badge`, `drawer`, ...) directly in JSX.
  Combine daisyUI classes; do not hand-roll markup/CSS for buttons, inputs, modals,
  dropdowns, layout primitives, etc.
- Only reach for custom CSS when daisyUI has no equivalent; keep such cases minimal and
  documented in a comment.
- Prefer daisyUI theme tokens (`primary`, `base-100`, `base-content`, ...) over hard-coded
  colors so light/dark themes keep working across platforms.

## Commands

- Dev: `yarn dev` (Vite) · Desktop dev: `yarn tauri dev`
- Build: `yarn build` (tsc + vite) · Bundle: `yarn tauri build`
- Release notes: `yarn release:notes:draft` (preview) · `yarn release:notes:draft -- --write` (write draft) · `yarn release:notes:check` (validate)

## Release & Changelog

- Releases are built exclusively from `main` by fast-forwarding `releases` to `main` (`.github/workflows/release.yml`).
- Before publishing a new version, keep versions aligned across `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` (and `src-tauri/Cargo.lock`), and update root `release-notes.md` before pushing `main`.
- `release-notes.md` is the single source of truth for GitHub Release body/asset, GitHub Pages (`latest.json` / `releases.json`), and the in-app "版本与更新" view.
- Format of `release-notes.md` (current version only; CI appends the GitHub `Full Changelog` compare link automatically):
  - First non-empty line: `## ✨ v<version> 更新内容` (must match `package.json` `version`).
  - Baseline summary line: `更新基线：在 v<previous> 基础上……`.
  - One or more `### <功能分组>` sections with user-facing `- ` bullet points (no raw commit hashes or CI build numbers).
- Run `yarn release:notes:draft` to group commits since the previous tag as a starting point, refine the wording for end users, and verify with `yarn release:notes:check` (`release.yml`'s `guard` job enforces this check).
