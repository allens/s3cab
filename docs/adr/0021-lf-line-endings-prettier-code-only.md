# LF line endings; Prettier formats code only, Markdown excluded

Line endings are normalised to **LF** via [.gitattributes](../../.gitattributes)
(`* text=auto eol=lf`), and Prettier formats **code only** — Markdown is excluded via
[.prettierignore](../../.prettierignore).

## Why LF everywhere

The working tree is LF on every platform, so Prettier's default `endOfLine` is satisfied with
**no `.prettierrc` needed**. This is load-bearing — beware the Windows trap that motivated it:
PowerShell's `>` / `Out-File` (and some editors) emit **UTF-16 + CRLF**; `.nvmrc` had silently
become UTF-16 this way, which `nvm`/`fnm` can't parse. Author dotfiles as plain UTF-8/ASCII
with LF.

## Why Markdown is excluded from Prettier

Its prose-emphasis restyle (`*x*` → `_x_`) and table-cell padding add churn and make the
frequently AI-edited docs fragile to edit, for no real gain (`proseWrap` doesn't reflow prose).

## Consequences

ESLint defers to Prettier (`eslint-config-prettier`) and ignores generated build artifacts.
Both ignore lists must cover the same set (`build`, `dist`, `coverage`); Prettier reads only
`.prettierignore`, not `.gitignore`, so a dir gitignored as output must also be listed there or
`format:check` will parse it once a build exists. Import order is author-managed — no tool
enforces or rewrites it (a `source.organizeImports`-on-save action was removed 2026-06).
