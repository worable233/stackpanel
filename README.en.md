<p align="center">
  <img src="apps/api/assets/brand/logo.png" width="104" alt="StackPanel logo">
</p>

<h1 align="center">StackPanel</h1>

<p align="center">A self-hosted, extensible business platform for digital goods and hosting, driven by AI Agents</p>

<p align="center">
  <a href="https://github.com/worable233/stackpanel/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/worable233/stackpanel/ci.yml?branch=main&style=flat-square&label=CI" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/worable233/stackpanel?style=flat-square" alt="MIT License"></a>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="#from-goal-to-execution">Agent</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#docs-and-operations">Docs</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a> ·
  <a href="./SECURITY.md">Security</a>
</p>

---

> [!TIP]
> StackPanel is still in early development. Releases may contain breaking changes, so read the release notes and back up your data before upgrading. Issues, design discussions, and pull requests are welcome.

StackPanel is a self-hosted, extensible business platform for digital goods and hosting. Its plugin kernel brings together orders, payments, fulfillment, tickets, and service operations. Built-in Agents turn those capabilities into executable workflows, so you can work from an objective instead of moving through an admin console page by page.

## From goal to execution

| Capability | What it gives you |
| --- | --- |
| **Start work with an Agent** | State the outcome you need. The Agent reads context, calls available capabilities, records the work, and asks a person to decide when required. |
| **Extend the business with plugins** | Plugins can declare routes, permissions, pages, events, data models, and capabilities. Store, tickets, and payment gateways are the start, not the platform's boundary. |
| **Keep autonomy governed** | An Agent never exceeds its caller's effective permissions. Administrators can restrict budgets, steps, and models; dangerous writes require approval, and every execution is auditable. |
| **Connect through one API** | The admin console, Agents, automation scripts, and third-party clients share REST APIs and typed contracts. Reviewed MCP tools and isolated actions expand the execution surface. |
| **Keep control through self-hosting** | Your data and deployment stay on your own servers. StackPanel uses PostgreSQL, with Redis and S3-compatible object storage for clustered deployments; backups cover the database and runtime data. |

## Quick start

These steps are for a Linux server managed with BaoTa or 1Panel. The panel manages the domain, HTTPS, and reverse proxy. StackPanel starts its own database, Redis, and object storage.

1. Confirm Docker is installed and running in the panel, then open the server terminal.
2. Point the domain's A record at this server. You will create the domain's reverse proxy and HTTPS certificate in the panel shortly.
3. Run these commands in the terminal:

```bash
git clone https://github.com/worable233/stackpanel.git
cd stackpanel

# Start StackPanel and generate required secrets
bash scripts/deploy.sh
```

4. The first start downloads and builds the components. When it completes, edit `docker/.env` in the project folder and replace the domain in both values below:

```dotenv
STACKPANEL_PUBLIC_URL=https://panel.example.com
STACKPANEL_API_PUBLIC_URL=https://panel.example.com
```

5. Run `docker compose --env-file docker/.env up -d` from the same folder. Create a reverse proxy for the domain in BaoTa or 1Panel with target `http://127.0.0.1:3000`, then issue an HTTPS certificate.
6. Open `https://your-domain` and follow the on-screen setup to create the first administrator. If the terminal prints a setup token, enter it in the setup page. It is also stored in `docker/.env` and expires after the administrator is claimed.

When you do not use BaoTa or 1Panel, StackPanel's bundled Caddy can configure HTTPS automatically. For your own database, a published image, or clustered deployment, continue with the [Docker guide](./docker/README.md).

```bash
# Without BaoTa or 1Panel, configure HTTPS with bundled Caddy
bash scripts/deploy.sh --domain sp.example.com --email you@example.com

# Cluster deployment with external PostgreSQL, Redis, and object storage
bash scripts/deploy.sh --cluster --image ghcr.io/<owner>/stackpanel@sha256:<digest>
```

Cluster mode requires `DATABASE_URL`, `REDIS_URL`, and `STORAGE_S3_*` in `docker/.env`. Production requires Redis and S3-compatible object storage.

## How it works

```text
              Objective ───> Built-in Agent
                                      │
                  Permissions · budgets · approvals · audit
                                      │
 Web console · Open REST API ──> Capability registry <── MCP / isolated actions
                                      │
  Kernel: RBAC · plugin runtime · theme engine · event bus · settings and secrets
                                      │
     Kernel services: payment orchestration · wallet ledger · FX · notifications
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
            Store                 Tickets / gateways       Other domains
           (plugin)                    (plugin)              (plugins)
```

The kernel owns platform capabilities and plugins own business change; Agents, the web console, and API clients use the same authorized capabilities. An administrator must configure and enable AI before an Agent can work. Third-party production plugins run in dedicated Node child processes by default; built-in and non-production plugins can use trusted mode. Permission fields govern route admission and frontend visibility, not operating-system sandboxing. See [plugin security and the trust model](https://github.com/worable233/stackpanel/wiki/Plugin-Security) for the full boundary.

## Docs and operations

| You want to | Start here |
| --- | --- |
| Deploy, use published images, or verify signatures | [Docker guide](./docker/README.md) |
| Back up or restore an instance | `bash scripts/backup.sh` and `bash scripts/restore.sh`; see the scripts for archive contents and recovery requirements. |
| Browse and install official plugins | [StackPanel official plugins](https://github.com/worable233/stackpanel-plugins) |
| Develop the kernel, a plugin, a theme, or a frontend package | [Developer Wiki](https://github.com/worable233/stackpanel/wiki) |
| Read the API contract | [`packages/spec`](./packages/spec) is the single source of truth for the kernel API version and OpenAPI projection. |
| Set up local development and follow code conventions | [Contributing guide](./CONTRIBUTING.md) |
| Investigate a production problem | [Operations runbook](./docs/OPERATIONS-RUNBOOK.md) |

Local development requires Node.js 22+, pnpm 11.5.1, PostgreSQL 16, and Redis 7. The [contributing guide](./CONTRIBUTING.md) has the full setup. These checks match CI:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## Contributing

Search existing issues before filing a new one. Bug reports should include reproduction steps, deployment mode, version, and sanitized logs. Feature requests should explain the business problem and intended outcome. Read the [contributing guide](./CONTRIBUTING.md) before opening a pull request; it covers testing, contracts, documentation, and license requirements.

Do not report security vulnerabilities publicly. Use [GitHub private vulnerability reporting](https://github.com/worable233/stackpanel/security/advisories/new); [SECURITY.md](./SECURITY.md) explains the process and scope.

## License

[MIT](./LICENSE). Third-party components and their licenses are listed in [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
