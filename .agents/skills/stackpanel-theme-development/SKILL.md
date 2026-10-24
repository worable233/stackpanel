---
name: stackpanel-theme-development
description: Build or review a StackPanel theme or frontend package using the host ABI, theme tokens, routes, Finders, settings and packaging contracts. Use for theme.json, theme CSS, frontend manifests, public pages, layouts, Finders or theme distribution.
---

# StackPanel Theme Development

Read `/Users/worable/Documents/StackPanel/AGENTS.md`, `packages/spec/src/frontend-abi.ts`, and `/Users/worable/Documents/StackPanel-docs/docs/developer-guide/{theme,frontend}/` before editing.

## Boundary

A theme controls presentation. Business permission checks, purchase flows, pricing, inventory, service actions and data authority stay in kernel or plugins. Public storefront pages remain display surfaces; authenticated commerce actions belong to the account flow and server authorization remains authoritative.

## Rules

- Declare only host externals and semver ranges supported by the current frontend ABI.
- Use documented CSS tokens and `@stackpanel/ui` primitives. Do not create a parallel design system.
- Declare pages, layouts, Finders and settings in the frontend manifest; validate all Finder input before domain use.
- Use localized messages for visible strings. Do not embed credentials, role decisions or server-only data in frontend artifacts.
- Keep an accessible empty, loading and error state for every data-dependent page.
- Theme-specific visuals and authoring details belong in the theme repository Wiki; the kernel guide only documents the theme contract.

## Verification

Build the frontend package and run the relevant app build after changing frontend artifacts. Verify manifest compatibility, route behavior and mobile/desktop layout before packaging and signing.
