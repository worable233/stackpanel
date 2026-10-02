# 镜像构建与分发（IMG-DIST）

本目录描述 StackPanel 内核镜像的**构建、发布、验签与拉取**。镜像以 monorepo 整体打包：
**api / worker / web 共用同一个镜像**，由不同入口脚本区分角色（见 `docker/entrypoint-*.sh`），
`docker-compose*.yml` 里三者指向同一 `STACKPANEL_IMAGE`。

## 1. 本地构建

```bash
# 直接构建 runtime 阶段（最终镜像）
docker build --target runtime -t stackpanel:local .

# 或用 compose（默认档会顺带起 PG/Redis/MinIO）
cp docker/.env.example docker/.env    # 填密钥
docker compose --env-file docker/.env up -d --build
```

`Dockerfile` 多阶段说明：

| 阶段      | 作用                                                                                          |
| --------- | --------------------------------------------------------------------------------------------- |
| `base`    | Node 22 + corepack + pnpm 11.5.1                                                              |
| `deps`    | `pnpm install --frozen-lockfile`（含各包 `prepare`：prisma generate / sdk / ui / 插件 build） |
| `build`   | `pnpm build`（含 `build:frontend` + `next build`）；`ARG API_BASE_URL` 影响构建期 CSP         |
| `runtime` | 安装 `postgresql-client-16`（自助导出/导入，ADR-0018），复制 `build` 产物与入口脚本           |

`.dockerignore` 已排除 `node_modules`、`data/`、`.env*`、`.git` 等，构建上下文干净。

## 2. 发布（GHCR + tag + Release Notes + cosign）

发布由 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 完成：

- **触发**：推送 `v*` 标签（如 `v1.2.3`）；或手工 `workflow_dispatch`（只构建/推送/签名，不建 Release）。
- **推送目标**：`ghcr.io/<owner>/stackpanel`（`<owner>` 为仓库所有者，自动转小写）。
- **标签策略**（`docker/metadata-action` 的 semver 派生）：

  | 触发                    | 产出标签                                                      |
  | ----------------------- | ------------------------------------------------------------- |
  | `v1.2.3`                | `1.2.3`、`1.2`、`1`、`latest`、`sha-<短哈希>`                 |
  | `v1.2.3-rc.1`（预发布） | `1.2.3-rc.1`、`1.2`、`1`、`sha-<短哈希>`（**不含 `latest`**） |
  | 手工触发                | 输入的 `tag`、`sha-<短哈希>`（**不含 `latest`**）             |

- **平台**：`linux/amd64`、`linux/arm64`（Buildx + QEMU 多架构清单）。
- **附带证明**：同一 digest 上推送 **SBOM** 与 **SLSA provenance**（BuildKit `sbom: true` / `provenance: true`）。
- **签名**：cosign **keyless**（GitHub OIDC）。签发身份绑定本仓库的 `release.yml`，无长期私钥。
- **Release Notes**：`v*` 标签推送时自动创建 GitHub Release，`generate_release_notes: true` 按提交历史汇总，
  正文追加镜像引用 / digest / 拉取与验签命令。预发布标签自动标 `prerelease`。

> 一次性前置：仓库需允许 Actions 写入 Packages（`permissions.packages: write`，工作流内已声明）。
> 首次发布后，把仓库可见性/包可见性设为 public（若希望匿名 `docker pull`）。

### 手工补发 / 重签

Actions → Release → Run workflow → 填 `tag`（如 `v1.2.3`）→ 运行。
它重跑构建/推送/签名，但**不**创建或修改 Release（Release 只在标签推送时生成）。

## 3. 校验签名（`scripts/verify-image.sh`）

```bash
# 需要 cosign：https://docs.sigstore.dev/cosign/system_config/installation/
# 需要 docker（用于把标签解析成摘要）

bash scripts/verify-image.sh ghcr.io/<owner>/stackpanel:v1.2.3
```

脚本行为：

1. 把标签解析为不可变 `sha256` 摘要（避免标签被覆盖的 TOCTOU），再用摘要校验。
2. `cosign verify` 绑定「签发身份 = 本仓库 `release.yml`」+「OIDC 签发方 = GitHub Actions」。
3. 打印摘要，供与 Release 正文 / 构建摘要核对。

签发仓库默认从 `git remote origin` 推断；无 remote 时用 `STACKPANEL_REPO=owner/name` 显式指定。

SBOM / 来源证明：

```bash
cosign download sbom ghcr.io/<owner>/stackpanel@sha256:<digest>
cosign verify-attestation \
  --certificate-identity-regexp "^https://github.com/<owner>/<name>/.github/workflows/release.yml@" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --type slsaprovenance \
  ghcr.io/<owner>/stackpanel@sha256:<digest>
```

## 4. 用发布镜像部署（不本地构建）

compose 中 api/worker/web 的镜像来自 `STACKPANEL_IMAGE`（缺省回退到本地构建的 `stackpanel-*:latest`）。
用 `deploy.sh --image` 部署发布版：

```bash
# 生产建议用不可变摘要引用（下方 <ref> 可为 v1.2.3 或 @sha256:...）
STACKPANEL_VERIFY_IMAGE=1 \
  bash scripts/deploy.sh --image ghcr.io/<owner>/stackpanel@sha256:<digest>

# 集群档同理
bash scripts/deploy.sh --cluster --image ghcr.io/<owner>/stackpanel:1.2.3
```

- `--image` 会：写 `STACKPANEL_IMAGE` 到 `docker/.env`、`docker compose pull`（不 build）、再 `up -d`。
- `STACKPANEL_VERIFY_IMAGE=1` 时先跑 `scripts/verify-image.sh` 校验签名；缺省只提示、不阻断。
- 后续手动运维可直接复用同一镜像：

  ```bash
  docker compose --env-file docker/.env up -d        # 读到 .env 里的 STACKPANEL_IMAGE
  ```
