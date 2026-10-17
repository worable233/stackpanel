# StackPanel

[简体中文](./README.md) · **English**

A self-hosted system for digital-goods and hosting businesses. Products, orders, payments, wallets, tickets, and access control all run on your own servers, and the data stays with you.

The kernel does six things — users & RBAC, plugin runtime, theme engine, event bus, settings & secrets, audit log — and injects cross-cutting capabilities (payment orchestration, wallet ledger, FX rates, in-app notifications) into plugins as kernel services. Business domains such as store, tickets, and payment gateways are plugins: only the minimal set required to run ships with the kernel, and the rest install on demand.

## Features

- **Business domains as plugins.** A plugin can declare its own routes, permissions, admin pages, account pages, event listeners, and data models, and can extend other plugins. Install, upgrade, enable, disable, and uninstall take effect without restarting the API process.
- **API first.** The admin console and the open API share one set of endpoints; anything the UI can do, a script can do.
- **Plugin frontends load at runtime.** A plugin's bundled UI is loaded by the web process on demand after install/upgrade — no rebuild or restart; reinstalls, uninstalls and rollbacks likewise take effect immediately.
- **Themes are ZIPs.** A theme is a configuration-driven ZIP package. Plugin frontends are type-safe React components sharing the same React runtime as the kernel. Page routes, named layouts, and typed finders are declared by the frontend package and rendered by the platform.
- **Credentials never exceed their owner.** Users can self-issue scoped API credentials; a credential's effective permissions are always a subset of the holder's current permissions. Downgrade a user and every credential they hold narrows with them.
- **Self-hosted and portable.** Production and development both use PostgreSQL; clustering relies on Redis and S3-compatible object storage. Backup is `pg_dump` plus asset packaging.

## Quick start

Prerequisites: **Docker** and **Docker Compose v2** (Linux / macOS / Windows via WSL2). Secret generation prefers `openssl` and falls back to `/dev/urandom`.

```bash
# One-shot deploy: detect Docker, generate random secrets, build and start.
# The default stack brings up api + worker + web + PostgreSQL + Redis + MinIO (HTTP, http://localhost:3000)
bash scripts/deploy.sh

# Public host with automatic HTTPS (domain DNS must already point here):
# bash scripts/deploy.sh --domain sp.example.com --email you@example.com

# Cluster stack (external PostgreSQL / Redis / object storage):
# bash scripts/deploy.sh --cluster --image ghcr.io/<owner>/stackpanel@sha256:<digest>
```

The first build pulls base images and dependencies, so it takes a while. When it finishes, open `http://localhost:3000`. The initial admin password is generated randomly and printed in the `api` container log; to pin it, set `STACKPANEL_BOOTSTRAP_EMAIL` and `STACKPANEL_BOOTSTRAP_PASSWORD` in `docker/.env` first.

Without Docker (existing local PostgreSQL and Redis, PM2 mode):

```bash
pnpm install
pnpm build
cp .env.example .env && cp apps/api/.env.example apps/api/.env && cp apps/web/.env.example apps/web/.env
pnpm --filter @stackpanel/db migrate:deploy
pnpm pm2:start
```

Development mode runs each app on its own with hot reload:

```bash
pnpm --filter @stackpanel/api dev   # Fastify
pnpm --filter @stackpanel/web dev   # Next.js
```

## Documentation

Developer documentation lives in the **[Wiki](https://github.com/worable233/stackpanel/wiki)**, in five parts:

| Section | Contents |
| --- | --- |
| [Core](https://github.com/worable233/stackpanel/wiki/Core-Prepare) | Environment prep, run, build, architecture, project structure, notifications |
| [Plugins](https://github.com/worable233/stackpanel/wiki/Plugin-Introduction) | Manifest, lifecycle, routes, extension points, events, secrets, dependencies, permissions, fulfillment, packaging |
| [Themes](https://github.com/worable233/stackpanel/wiki/Theme-Introduction) | Theme structure, manifest, CSS tokens, settings, frontend package, packaging |
| [Frontend packages](https://github.com/worable233/stackpanel/wiki/Frontend-Getting-Started) | Pages, layouts, finders, admin extensions, UI conventions, troubleshooting |
| [RESTful API](https://github.com/worable233/stackpanel/wiki/Api-Introduction) | Authentication, route reference, SDK client, error handling |

Interface contracts use [`packages/spec`](./packages/spec) as the single source of truth (kernel API version + OpenAPI projection).

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

## Plugin execution and trust model

The manifest's `execution` field selects how a plugin runs:

- **`isolated`**: the production default for third-party packages. The entrypoint runs in a dedicated Node child process; the API process keeps only the manifest, the route proxy, and an RPC bridge. `ctx.*` crosses the boundary over IPC RPC with a protocol version, plugin identity checks, a 1 MiB message cap, 64 concurrent calls, and a 10-second bidirectional timeout. A worker exit marks the plugin `failed` and clears its routes, models, and jobs; three exits in total trip a circuit that requires re-registering a repaired package.
- **`trusted`**: available to built-in packages in every environment and to any plugin outside production. The plugin runs inside the API process with that process's permissions; third-party production packages may not request this mode.

The manifest `permissions` and route `permission` fields are **route-admission and frontend-visibility** controls, not an OS sandbox, and `isolated` is not a full container. `ctx.events.intercept()` and `ctx.events.waterfall()` require synchronous return values and cannot be expressed across processes, so they fail explicitly in isolated mode; raw streaming routes and custom models that cannot be represented as JSON Schema are rejected at worker startup. `PluginContext` exposes no database handle: plugins read and write only their own declared models through the Extension engine.

See [plugin security and the trust model](https://github.com/worable233/stackpanel/wiki/Plugin-Security).

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

## Development

| Requirement | Version |
| --- | --- |
| Node.js | >= 22 (see [`.nvmrc`](./.nvmrc)) |
| pnpm | 11.5.1 (pinned by the `packageManager` field) |
| PostgreSQL | 16 |
| Redis | 7 |

Run the same checks as CI before pushing:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Local setup, coding standards, and the review flow are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

Report vulnerabilities through GitHub's private vulnerability reporting channel rather than a public issue. Process and scope are in [SECURITY.md](./SECURITY.md).

## Dependencies and licensing

Third-party components and their licenses are listed in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md), with full license texts in [`licenses/`](./licenses/). `pnpm license:check` fails CI on any copyleft dependency that is not documented there.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Code of Conduct](./CODE_OF_CONDUCT.md) first. Release notes are in [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
