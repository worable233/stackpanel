---
name: stackpanel-plugin-development
description: Build or review a StackPanel plugin that conforms to the kernel extension, isolation, permission, capability and packaging contracts. Use for new plugins, plugin routes, manifests, extensions, events, storage, permissions or plugin distribution.
---

# StackPanel Plugin Development

Read these before editing:

1. `/Users/worable/Documents/StackPanel/AGENTS.md`
2. `/Users/worable/Documents/StackPanel/packages/sdk/src/plugin.ts`
3. `/Users/worable/Documents/StackPanel-docs/docs/developer-guide/plugin/`

## Boundary

The kernel defines the extension contract. The plugin repository owns its domain model, configuration, deployment guide, operation manual and domain API examples. Do not put plugin-specific business documentation in the kernel Wiki.

## Required implementation rules

- Set `manifest.apiVersion` to a range compatible with `KERNEL_API_VERSION` in `@stackpanel/spec`.
- Treat third-party server plugins as isolated unless there is an explicit reviewed reason for trusted execution.
- Use `ctx.extensions` for plugin data. Never use raw Prisma/database access.
- Declare every route's auth and permission at the route boundary; handlers must still validate resource ownership and business invariants.
- Register permissions in the manifest. A `permission.scope` may only govern its own refined resource namespace.
- Keep secrets in `ctx.secrets`; never include them in frontend code, errors, events, logs or audit meta.
- Put cross-plugin contracts behind extension points or typed events. Do not import another plugin's internals.
- When shipping frontend code, obey the host frontend ABI and declared externals.

## Public capability flow

For a plugin operation exposed through `/api/v1`, MCP or Agent:

1. Implement and test the normal plugin route first.
2. Add `manifest.capabilities` that mirrors this exact route.
3. Ensure the public path begins with `/api/v1/`, is globally unique and does not target a `raw` route.
4. Define an Agent Surface using `stackpanel-agent-surface` before exposing a mutating or destructive operation.
5. Update the plugin repository Wiki with domain semantics and examples; update the kernel guide only when the shared contract changes.

## Verification

Run the narrowest relevant checks, then run `pnpm typecheck`. For server changes run the focused unit/integration test. For package changes build the plugin with `node scripts/build-plugin.mjs` and verify install/manifest compatibility.
