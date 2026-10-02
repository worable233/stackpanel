# StackPanel Default Theme

Built-in theme for StackPanel. **Configuration only — no executable code.**

## Theme package protocol

A theme ZIP is loaded dynamically and MUST contain:

| File         | Purpose                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------- |
| `theme.json` | Manifest: `id`, `name`, `version`, `author`, `layout` hints, `supportsDarkMode`, `assets` |
| `theme.css`  | Design tokens as CSS variables — light mode in `:root`, dark mode in `.dark`              |
| `assets/*`   | Static images (logo, favicon, …) referenced by the manifest                               |

Rules:

- **No executable code** (`.js`/`.ts`) is allowed inside a theme package. Safety + simplicity.
- Tokens follow the shadcn/ui CSS-variable convention (`--background`, `--foreground`, `--primary`, …) so the same theme drives both user and admin surfaces.
- Themes must cover light **and** dark mode.
- The `default` theme cannot be removed and is the fallback when a loaded theme is missing.

## Validation

- `theme.json` must be valid JSON.
- `theme.css` must define both `:root` and `.dark` variable sets.
