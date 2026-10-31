# 发版流程（内核 `vX.Y.Z`）

> 本文件是**内核发版的唯一流程说明**。发版只有一条标准路径：本地预检 → 提交版本号 →
> 打标签 → 推送标签 → CI 自动构建与发布。不允许"手工推镜像 + 手工改 Release"的旁路，
> 那样签名、清单与产物摘要会与标签脱钩。

## 0. 版本号的三个维度

发版前先分清三个互不相干的版本，混用是历史上最常见的错误：

| 常量 | 位置 | 管什么 | 什么时候改 |
|---|---|---|---|
| `KERNEL_VERSION` | `packages/spec/src/version.ts` | **产品版本**：镜像标签 `vX.Y.Z`、运行时 `/health` 汇报的版本 | 每次内核发版 |
| `KERNEL_API_VERSION` | 同文件 | **契约版本**：插件 `manifest.apiVersion` 的兼容基准 | 契约破坏性变更时（与 SDK / `@stackpanel/spec` / `@stackpanel/mcp` 的 npm 版本同步） |
| `KERNEL_FRONTEND_ABI` | 同文件 | **前端 ABI**：宿主提供的 React / next 槽兼容面 | 宿主前端 ABI 变化时 |

`KERNEL_VERSION` 是**唯一来源**，下列包的 `package.json` 的 `version` 必须与它完全一致
（由 `packages/spec/tests/spec.test.ts` 钉死，改了不同步就会红）：

```
package.json
apps/api/package.json      apps/web/package.json      apps/updater/package.json
packages/db/package.json   packages/ui/package.json   packages/net-guard/package.json
```

插件包（`packages/plugins/*`）与主题包有**自己的**版本号，不随内核发布变动。

## 1. 本地预检（必做，秒级）

```bash
pnpm release:preflight --version 0.1.0
```

它逐项检查并在最后列出所有阻塞点（不会只报第一个）：

- 工作区干净（版本号改动必须先提交，标签要指向真实提交）；
- `KERNEL_VERSION` == 目标版本；
- 上面 7 个包的 `version` 与 `KERNEL_VERSION` 一致；
- `KERNEL_VERSION` **只有一处定义**（别处再抄一份就会漂移）；
- `CHANGELOG.md` 有 `## [0.1.0]` 段落且非空；
- 标签 `v0.1.0` 在本地与远端都不存在。

预检通过后打印后续命令。

## 2. 门禁（CI 会跑，本地先跑一遍省时间）

```bash
pnpm typecheck && pnpm lint && pnpm test      # lint 目前本地缺依赖，以 CI 为准
pnpm i18n:check && pnpm i18n:packages && pnpm i18n:hant:check
pnpm --filter @stackpanel/api contract:snapshot -- --check   # 契约破坏性变更闸
pnpm release:rehearse                          # 分发链路离线演练（签名/验签/故障注入）
```

`release:rehearse` 通过是发版前提：它用**与实例端同一个验证器**回读目录与清单，
证明"发布端怎么签"与"实例端怎么验"没有漂移。

## 3. 收口 CHANGELOG

把 `## [Unreleased]` 下的内容移到新的 `## [<version>] - YYYY-MM-DD` 段落。
`[Unreleased]` 保留为空标题，供下一个版本累积。

约定：**公开发布的版本号只增不减**。若把内部里程碑号改成公开首发号，就在新段落下写明
"某某号此前从未发布，现改标为内部里程碑"，不要删掉旧记录。

## 4. 提交、打标签、推送

```bash
git add -A
git commit -m "chore(release): v0.1.0"
git tag -a v0.1.0 -m "v0.1.0"
git push origin main
git push origin v0.1.0
```

**推标签即发版**。标签是唯一触发源，不要用 `workflow_dispatch` 造 Release
（那条路径只构建镜像，不建 Release）。

## 5. CI 自动做了什么

`.github/workflows/release.yml` 在 `v*` 标签上：

1. 构建并推送多架构镜像 `ghcr.io/<owner>/stackpanel`（`linux/amd64`、`linux/arm64`），
   带 SBOM 与 SLSA provenance；
2. cosign **keyless** 签名镜像摘要并自检验签；
3. 构建自包含产物（ADR-0025）：`stackpanel-<v>-kernel-linux-x64.tar.zst`、
   `stackpanel-<v>-migrate-linux-x64.tar.zst`、upgrade runner；
4. 生成并签名内核清单 `kernel-manifest.json` + `.sig` + `kernel-ref.json`；
5. 以同一 tag 创建 GitHub Release，附上上述资产，并用提交历史自动生成 Release Notes。

### 需要配置的仓库变量与密钥

| 名称 | 类型 | 缺失时 |
|---|---|---|
| `KERNEL_MANIFEST_SIGNING_KEY` | secret（Ed25519 私钥） | **跳过清单与产物资产**，只发镜像 + Release（带告警） |
| `KERNEL_MANIFEST_SIGNING_KEY_ID` | variable | 同上跳过 |
| `KERNEL_DATABASE_MIGRATION` | variable | 有签名密钥但此项为空时**直接失败**（拒绝发布含空迁移标识的清单） |
| `KERNEL_API_VERSION` / `KERNEL_UPGRADE_FROM` / `KERNEL_SCHEMA_RANGE` | variable | 取工作流内默认值 |

生产自动更新**不允许**跳过验签，所以正式对外发布前必须先把签名密钥配上。

#### 首次发布前：生成并登记签名密钥

macOS 自带的 `openssl` 是 LibreSSL，**不支持** `genpkey -algorithm ed25519`，用 Node 生成：

```bash
node -e '
const { generateKeyPairSync } = require("node:crypto");
const fs = require("node:fs");
const dir = process.env.HOME + "/.stackpanel-release";
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
fs.writeFileSync(dir + "/kernel-signing.pem", privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(dir + "/kernel-signing.pub.pem", publicKey.export({ type: "spki", format: "pem" }));
'
```

私钥只存在本地（`~/.stackpanel-release/kernel-signing.pem`，权限 600），**不要**提交到仓库。
`keyId` 用发布年月，便于轮换时一眼看出新旧：`kernel-2026-11`。

```bash
KEY_ID=kernel-2026-11
gh secret set KERNEL_MANIFEST_SIGNING_KEY < ~/.stackpanel-release/kernel-signing.pem
gh variable set KERNEL_MANIFEST_SIGNING_KEY_ID --body "$KEY_ID"
# 迁移标识 = packages/db/prisma/migrations 下最新的目录名，与 migrate 产物必须一致
gh variable set KERNEL_DATABASE_MIGRATION --body "$(ls packages/db/prisma/migrations | grep -v migration_lock | tail -1)"
```

**公钥必须随部署写入实例**，否则实例侧无法验签——内核从数据目录读 `trust/keyring.json`
（即 `<数据目录>/trust/keyring.json`，部署时写入、升级不覆盖），`purpose` 必须是 `kernel`：

```json
{
  "keys": [
    { "keyId": "kernel-2026-11", "purpose": "kernel", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n..." }
  ]
}
```

本地可以先照 CI 的做法自检一遍（`--keyring` 会让脚本用实例端同一个校验函数回读签名）：

```bash
node scripts/release/build-kernel-manifest.mjs \
  --input kernel.meta.json \
  --key-file ~/.stackpanel-release/kernel-signing.pem \
  --key-id kernel-2026-11 \
  --keyring /tmp/kexp/keyring.json \
  --out /tmp/kexp
```

轮换：生成新 keyId 的密钥对 → 先把**新公钥**加到所有实例的 keyring（旧的保留）→ 再切
`KERNEL_MANIFEST_SIGNING_KEY(_ID)` 发下一版 → 确认所有实例升级后移除旧公钥。顺序反了会让
仍持旧 keyring 的实例拒绝新版本。


## 6. 验收

```bash
gh run watch                                   # 跟随本次标签触发的发布
gh release view v0.1.0                         # 资产清单
docker pull ghcr.io/<owner>/stackpanel:0.1.0
cosign verify \
  --certificate-identity-regexp "^https://github.com/<owner>/stackpanel/.github/workflows/release.yml@" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<owner>/stackpanel@<digest>
```

验收三件事：**镜像摘要与 Release 正文一致**、**验签通过**、**`kernel-manifest.json` 的
`version` 等于标签**（缺签名密钥时第三项不存在，应在 Release 说明里注明）。

## 7. 回滚

发版不可覆盖。要重发同一版本号，必须显式撤销：

```bash
gh release delete v0.1.0 --yes --cleanup-tag
git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0
# 修问题 → 重新走第 1 步（预检会拦住重复标签）
```

镜像一旦被 `latest` 指向就无法"取消发布"，只能发新版本让更新中心的清单指向新摘要。
因此**先本地跑完第 2 步的门禁，再推标签**。

## 8. 插件与主题的发版

插件/主题走的是**应用市场目录**，与内核标签无关：`pnpm release:manifest` →
`pnpm release:catalog` → `.github/workflows/publish-catalog.yml`。内核清单里的
`upgradeFrom` 决定实例能从哪些旧版本直接升，市场目录里的 `compatibility.kernel`
决定插件能装在哪些内核上，两者不要互相顶替。
