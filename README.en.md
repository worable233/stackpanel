# StackPanel

[简体中文](./README.md) · **English**

**A self-hosted platform for digital goods and hosting businesses.** Put products, orders, payments, wallets, tickets, and access control into one self-hosted system—with the data staying on your own servers.

It is not another control panel, and not SaaS. It is closer to what WordPress is for content or Halo is for blogs—except it is built for running a digital-goods and hosting business. Install only the plugins you need, or write your own.

## Why StackPanel

Existing solutions tend to be closed panels, lock your data in someone else's cloud, or force an unchangeable business logic on you. StackPanel takes the opposite approach:

- **Thin kernel, fat plugins.** The kernel does only six things—users & RBAC, plugin runtime, theme engine, event bus, settings & secrets, audit log—and injects cross-cutting capabilities (payment orchestration, wallet ledger, FX rates, in-app notifications) into plugins as kernel services. Everything else is a plugin, including business domains such as store, tickets, and gateway; the kernel ships only the minimal set of plugins required to run, and installs the rest on demand.
- **API first, always.** The admin console is not a privileged client—it is the first consumer of this API. Anything you can do in the UI, a script can do too.
- **Your data is yours.** Self-hosted, PostgreSQL as the single storage engine, and backup is just `pg_dump` plus asset packaging. Migrate away whenever you want.

## Capabilities

**Plugins install and run without restarting.** Install, upgrade, enable, disable, and uninstall all take effect immediately—the API process does not need to restart. Plugins can declare their own routes, permissions, admin pages, account pages, and event listeners, and can even extend other plugins. A plugin's bundled frontend is built automatically by the worker (ADR-0007): after a change it runs `build:frontend` + `next build`, and each web replica restarts on its own; manual `pnpm build` is only needed when `STACKPANEL_FRONTEND_AUTOBUILD` is off.

**A credential's permissions never exceed its owner's.** Users can self-issue API credentials with a scoped grant; the effective permissions of a credential are always a subset of the holder's current permissions. Downgrade a user and every credential they hold narrows with them—there is no parallel authorization system.

**Themes and frontends are first-class.** A theme is a ZIP; a plugin frontend is a type-safe React component sharing the same React runtime as the kernel. Page routes, named layouts, and typed data finders are all declared by the frontend package, and the platform renders them.

**Plugins can carry their own data model.** There is no need to bend to the kernel's schema—plugins can define new business objects and their UIs.

**PostgreSQL by default.** Production and development both use PostgreSQL (ADR-0019); clustering relies on Redis and S3-compatible object storage (ADR-0017). Bring up the whole stack with one command: `bash scripts/deploy.sh` starts api + worker + web + PostgreSQL + Redis + MinIO, initializes automatically, and is ready to use right after install.

## Architecture

```
                            Kernel
   Six things: Users & RBAC · Plugin runtime · Theme engine
               Event bus · Settings & secrets · Audit log
   Capability services: Payment orchestration · Wallet ledger · FX · Notifications
                                  |
                   +--------------+--------------+
                   |              |              |
                 Store       Tickets/Gateway    Content …
               (plugin)         (plugin)       (plugin)
                   |              |              |
                   +--------------+--------------+
                                  |
                          One shared REST API
                   +--------------+--------------+
                   |              |              |
              Web console      Open API        Third-party clients
```

## Quick start

Prerequisites: **Docker** and **Docker Compose v2** installed (Linux / macOS / Windows via WSL2). Secret generation prefers `openssl` and falls back to `/dev/urandom` when absent.

```bash
# One-shot deploy: detect Docker, generate random secrets, build and start.
# The default stack brings up api + worker + web + PostgreSQL + Redis + MinIO (HTTP, http://localhost:3000)
bash scripts/deploy.sh

# Public host with automatic HTTPS (domain DNS must already point here):
# bash scripts/deploy.sh --domain sp.example.com --email you@example.com

# Cluster stack (external PostgreSQL/Redis/object storage):
# bash scripts/deploy.sh --cluster --image ghcr.io/<owner>/stackpanel@sha256:<digest>
```

The first build pulls base images and dependencies, so it takes a while; when it finishes, open `http://localhost:3000`. Initial admin: a random password is generated and printed in the `api` container log by default (to pin it, set `STACKPANEL_BOOTSTRAP_EMAIL` / `STACKPANEL_BOOTSTRAP_PASSWORD` in `docker/.env` first).

Without Docker (existing local PostgreSQL/Redis, PM2 mode):

```bash
pnpm install
pnpm build
cp .env.example .env && cp apps/api/.env.example apps/api/.env && cp apps/web/.env.example apps/web/.env
pnpm --filter @stackpanel/db migrate:deploy
pnpm pm2:start
```

Development mode:

```bash
pnpm --filter @stackpanel/api dev   # Fastify, hot reload
pnpm --filter @stackpanel/web dev   # Next.js, hot reload
```

## Project structure

```
StackPanel/
├── apps/
│   ├── api/     # Fastify service hosting the full business API
│   └── web/     # Next.js rendering and BFF proxy (no business logic)
└── packages/
    ├── sdk/            # Type-safe API client and plugin contracts
    ├── spec/           # Single source of truth: kernel API version and OpenAPI projection
    ├── ui/             # Shared components
    ├── db/             # Prisma schema, migrations, and client
    ├── net-guard/      # Shared network-guard primitives (SSRF checks, etc.)
    ├── plugins/        # Built-in plugins: auth, store and product types, wallet
    ├── themes/         # Configurable themes
    └── mcp/            # MCP Server (stdio / HTTP)
```

## Documentation

Developer documentation is published in the **[Wiki](https://github.com/worable233/stackpanel/wiki)**, covering five parts: core, plugins, themes, frontend packages, and the RESTful API.

| Section | Contents |
| --- | --- |
| [Core](https://github.com/worable233/stackpanel/wiki/Core-Prepare) | Environment prep, run, build, architecture, project structure, notifications |
| [Plugins](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction) | Manifest, lifecycle, routes, extension points, events, secrets, dependencies, permissions, fulfillment, packaging |
| [Themes](https://github.com/worable233/stackpanel/wiki/Theme-Introduction) | Theme structure, manifest, CSS tokens, settings, frontend package, packaging |
| [Frontend packages](https://github.com/worable233/stackpanel/wiki/Frontend-Getting-Started) | Pages, layouts, finders, admin extensions, UI conventions, troubleshooting |
| [RESTful API](https://github.com/worable233/stackpanel/wiki/Api-Introduction) | Authentication, route reference, SDK client, error handling |

In-repo interface contracts use [`packages/spec`](./packages/spec) as the single source of truth (kernel API version + OpenAPI projection).

## License

[MIT](./LICENSE)
