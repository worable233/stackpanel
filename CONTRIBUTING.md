# 贡献指南

感谢你愿意参与 StackPanel。本文件说明本地环境、代码规范与提交流程。

## 环境要求

| 依赖           | 版本                                     |
| -------------- | ---------------------------------------- |
| Node.js        | >= 22（见 `.nvmrc`）                     |
| pnpm           | 11.5.1（由 `packageManager` 字段锁定）   |
| PostgreSQL     | 16（生产与开发统一使用，唯一存储引擎）   |
| Redis          | 7（集群化依赖）                          |
| Docker / Compose v2 | 仅在容器化运行时需要               |

启用 Corepack 后 pnpm 版本会自动对齐：

```bash
corepack enable
corepack prepare pnpm@11.5.1 --activate
```

## 本地开发

```bash
pnpm install

cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

pnpm --filter @stackpanel/db migrate:deploy   # 首次建库
pnpm dev                                      # 全量并行热重载
```

只跑单个应用：

```bash
pnpm --filter @stackpanel/api dev   # Fastify，热重载
pnpm --filter @stackpanel/web dev   # Next.js，热重载
```

不想装本机 PostgreSQL/Redis 时，可用容器一键起全栈：

```bash
bash scripts/deploy.sh
```

## 提交前必须通过

与 CI 保持一致，请在推送前本地跑一遍：

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

涉及接口契约时额外确认契约快照未被意外改动（CI 的 contract snapshot 步骤会拦截破坏性变更）。
涉及界面时再跑 `pnpm test:e2e`。

## 代码规范

- **TypeScript strict**，禁止 `any` 逃逸；不要用 `@ts-ignore` 掩盖类型问题。
- 格式与静态检查由 Prettier + ESLint 统一，提交前跑 `pnpm format`。
- 提交信息遵循 Conventional Commits：`feat` / `fix` / `docs` / `refactor` / `perf` / `test` / `build` / `ci` / `chore`，并带 scope，例如 `fix(plugin-runtime): ...`。
- 新增行为必须带测试。测试放在对应包的 `tests/` 目录，命名 `*.test.ts`。
- 不引入 copyleft 许可的依赖：CI 的 `pnpm license:check` 会拒绝。

## 不要提交的内容

- `node_modules/`、`dist/`、`.next/`、构建产物与打包出的 `*.zip` / `*.tgz`
- 任何密钥、token、真实域名与个人路径；只提交 `.env.example`
- 本机运行时数据：`data/`、`var/`、日志、测试数据库文件
- 内部开发笔记、实现计划与本地工具配置

`pnpm-lock.yaml` 必须提交：CI 使用 `--frozen-lockfile`，锁文件缺失或不一致会直接失败。

## 提交流程

1. 先开 issue 说明问题或提案，比较大的改动请先讨论方案再动手。
2. 从 `main` 切出分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
3. 保持提交粒度清晰，一次提交只做一件事。
4. 发起 PR，说明动机、实现方式、验证方法与影响的用户范围。
5. 等 CI 全绿后再请求评审。

## 文档

用户可见的行为变更请同步更新 README 与 [Wiki](https://github.com/worable233/stackpanel/wiki)。

文档有两套，注意不要混：面向使用者的公开文档（README、Wiki）与仓库内部的开发笔记相互独立，
公开文档中不得引用内部笔记。

## 安全问题

不要用 PR 或公开 issue 报告漏洞，请按 [SECURITY.md](./SECURITY.md) 的流程私下报告。
