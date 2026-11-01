# 发布 updater 镜像（`stackpanel-updater`）

> 目标：让「拉镜像部署、零本地构建」这条路径对 `updater` 服务也成立。
>
> **状态：已实现（2026-11-01，`v0.1.1`）**。下面的「现状」表保留原问题描述，
> 每行后面标了现在的实现位置；§3 消费侧三处已改完，§4 包可见性仍需首次发布后手工点一次。

## 1. 原缺口与现已实现的位置

| 项目 | 原问题 | 现在 |
| --- | --- | --- |
| `.github/workflows/release.yml` | 只发布 `stackpanel` 主镜像 | 新增 job `publish-updater`（`needs: publish`，仅标签触发），调起可复用工作流 |
| `.github/workflows/publish-updater.yml` | 不存在 | 新建：可 `workflow_call` + `workflow_dispatch`；按**标签**检出、`target: runtime`、`scope=updater` 独立缓存、cosign keyless 签名 + 自检 |
| `docker-compose.yml` → `updater` | 同时写 `build` 与 `image` | 保留双写（本地开发仍走 build），但 `deploy.sh --image` 现在会写入 `STACKPANEL_UPDATER_IMAGE`，发布部署不再構到 build |
| `scripts/deploy.sh` | `--image` 不写 updater 镜像 | 新增 `--updater-image`；带 `<tag>` 的 `--image` 自动推导 `<仓库>-updater:<tag>`，摘要引用/无 tag 时明确告警要求显式给 |
| `scripts/verify-image.sh` | 只认 `release.yml` 的签发身份 | 按镜像名自动选 `publish-updater.yml`（可用 `STACKPANEL_IMAGE_WORKFLOW` 覆盖） |
| `docker/README.md` | 两节只讲主镜像 | 已补 updater 镜像、补发命令与验签命令 |

### 为什么 updater 单独一份工作流

不能只往 `release.yml` 里加一个 job 然后靠它的 `workflow_dispatch` 补发：那条路径会把
`stackpanel:0.1.1` 这类**主镜像**版本标签重新指向一个新摘要，而已签名的内核清单
（`kernel-manifest.json`）里写死了旧摘要——两者对不上，等于发布了一版没人能验过的镜像。
所以 updater 是可复用工作流：标签发布时由 `release.yml` 调起，补发时直接 dispatch 它自身，
按 `tag` 检出对应提交，只动 updater 镜像。

实际的 job 定义见 `.github/workflows/publish-updater.yml`。三条约束照旧：
`context` 必须是仓库根、`target: runtime`、GHCR 缓存用 `scope=updater`。

## 2. 手工补发

```bash
gh workflow run publish-updater.yml --ref main -f tag=v0.1.1
```

镜像是按 `tag` 检出的，所以补发的旧版本不会带上后来的代码变更。`latest` 默认不打，
只有当它确实是最新正式版时再加 `-f latest=true`。

### 三条约束（写在 `publish-updater.yml` 的注释里，别改回去）

1. **`context` 必须是仓库根**，不能写 `context: ./apps/updater`。
   `apps/updater/Dockerfile` 会 `COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json`、
   `COPY packages/spec`、`COPY apps/updater`，上下文放小了会直接构建失败。
2. **`target: runtime`** 才是不带源码/pnpm/构建器的运行时镜像；`build` 阶段可以丢掉。
3. **GHCR 缓存要用独立 `scope`**（`scope=updater`），否则会和主镜像的 `type=gha` 缓存互相覆盖，
   表现为「命中缓存但层对不上，构建变慢或报错」。

## 3. 消费侧（已改完）

1. `docker/.env` 的 `STACKPANEL_UPDATER_IMAGE`：由 `deploy.sh --image` 自动写入；手工部署时自己加一行
   ```dotenv
   STACKPANEL_UPDATER_IMAGE=ghcr.io/worable233/stackpanel-updater:0.1.1
   ```
2. `scripts/deploy.sh`：新增 `--updater-image`；`--image` 带 `<tag>` 时自动推导
   `<仓库>-updater:<tag>`，**摘要引用或没有 tag 时明确告警**要求显式给（推导不出来，
   静默退回本地标签就会让 `up -d` 去 build）。
3. `scripts/verify-image.sh`：签发身份按镜像名自动选——`stackpanel-updater` 认
   `publish-updater.yml`，其余认 `release.yml`；不这么改，updater 镜像永远验不过。
4. `docker/README.md`：发布 / 补发 / 验签 / `--image` 四节都补上了 updater 镜像。


## 4. 包可见性

首次发布后到 GitHub → 仓库 → Packages → `stackpanel-updater` → **Change visibility → Public**。
保持 private 时，部署端 `docker pull` 会 401（主镜像目前是 public，容易漏掉这一步）。

## 5. 验证

```bash
docker pull ghcr.io/worable233/stackpanel-updater:0.1.1
bash scripts/verify-image.sh ghcr.io/worable233/stackpanel-updater:0.1.1
docker run --rm --entrypoint sh ghcr.io/worable233/stackpanel-updater:0.1.1 \
  -c 'command -v docker && docker compose version && command -v pg_restore'
```

## 6. 版本与运行期约束

- **版本必须与内核同号**（`0.1.1` ↔ `0.1.1`）。updater 协议版本由内核清单
  （`kernel-ref.json` / `KERNEL_MANIFEST`）声明，跨号会导致升级任务被拒。
- 运行期必须有：
  - `/var/run/docker.sock`（updater 唯一持有 Docker socket）
  - `DOCKER_GID` 与宿主 `docker` 组 gid 一致，否则容器内 `docker` 命令 permission denied
  - `STACKPANEL_HOST_DIR` 为宿主上的**绝对路径**（updater 从容器内执行
    `docker compose up -d updater`，相对路径会指向容器内目录而失败）
- 镜像发布并验证通过后，可以把 `docker-compose.yml` 里 `updater` 的 `build:` 段删掉，
  彻底消除「误触发本地构建」的可能。
