# Atlas

Monochrome cloud storefront for StackPanel. White space, tight grotesque type,
pill controls, rounded cards and restrained motion — shadcn/ui conventions with
Base UI primitives from `@stackpanel/ui`.

## Stack

| Layer      | Choice                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Runtime    | React 19 (host ABI)                                                    |
| UI system  | **shadcn/ui** conventions via `@stackpanel/ui` (`Button`, `Input`, tokens) |
| Motion     | Real Animate UI Base UI primitives (`Tabs`) through the host `@stackpanel/ui` bridge, plus `tw-animate-css` entrance utilities |

The theme frontend is loaded by the host RSC loader. It is server-only: no
`'use client'`, hooks, context or inline styles. Client-only primitives are
re-exported as individual client references by `packages/ui/src/animate-ui/`
and consumed from `@stackpanel/ui`; the theme ZIP itself stays self-contained.

## Package layout

```
theme.json                      manifest (id, layout hints, assets)
theme.css                       light (:root) + dark (.dark) design tokens
assets/                         logo + favicon
frontend/src/index.tsx          layout, pages, settings schema
frontend/src/settings.ts        settings schema + safe link helper
frontend/messages/*.json        zh-CN, zh-TW, zh-HK, en-US catalogs
```

## Pages

| Path            | Component | Data                                             |
| --------------- | --------- | ------------------------------------------------ |
| `/`             | home      | catalog finders, falling back to `store.categories` / `store.products` |
| `/shop`         | shop      | catalog finders, falling back to `store.categories` / `store.products` |
| `/shop/:id`     | product   | `store.product`, `store.paymentMethods`, `store.viewer` |
| `/shop/cart`    | cart      | `store.cart`, `store.paymentMethods`             |
| `/about`        | about     | static                                           |
| `/guide`        | guide     | static notes                                     |
| `/guide/:slug`  | guidePost | static notes                                     |
| `*`             | notFound  | fallback                                         |

The `theme` layout wraps plugin pages too, so store/plugin routes inherit the
Atlas chrome.

## Develop

From the repository root:

```bash
pnpm build:frontend          # compiles every theme/plugin frontend
node scripts/check-package-catalogs.mjs
node scripts/i18n-hant.mjs --check
```

Source of truth:

- Change copy → `frontend/messages/zh-CN.json` and `en-US.json`, then run
  `pnpm i18n:hant` to regenerate `zh-TW` / `zh-HK`.
- Change operator-editable copy → `frontend/src/settings.ts` defaults.
- Change colors → `theme.css`; use only `:root` / `.dark` token blocks.
- Never hand-edit `frontend/manifest.json` (build output).

The host includes this theme's Tailwind sources through
`apps/web/src/app/globals.css` (`@source`).

## Install

Upload `dist-pack/themes/atlas-1.0.0.zip` in **Admin → Themes**, then
activate it as a separate action. The archive contains exactly:

```
theme.json
theme.css
assets/logo.svg
assets/favicon.svg
frontend/manifest.json
frontend/dist/index.js
```

Do not add `frontend/package.json` or source files: the theme upload validator
accepts only `frontend/manifest.json` and `frontend/dist/*.{js,map,css}`.

## Boundary

Presentation only. Catalog, stock, pricing, checkout and payment authority stay
with the store/catalog plugins and the kernel. The theme renders finders and
posts to declared actions; it never makes authorization decisions.
