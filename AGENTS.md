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
