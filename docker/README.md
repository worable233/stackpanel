# 镜像构建与分发（IMG-DIST）

本目录描述 StackPanel 内核镜像的**构建、发布、验签与拉取**。镜像以 monorepo 整体打包：
**api / worker / web 共用同一个镜像**，由不同入口脚本区分角色（见 `docker/entrypoint-*.sh`），
`docker-compose*.yml` 里三者指向同一 `STACKPANEL_IMAGE`。

## 1. 本地构建

```bash
# 直接构建 runtime 阶段（最终镜像）
docker build --target runtime -t stackpanel:local .

# 或用 compose（默认档会顺带起 PG/Redis/MinIO）
# 推荐：用 deploy.sh 自动生成随机密钥，无需手填
bash scripts/deploy.sh
# 手动方式（必须自己填 JWT_SECRET / SETTINGS_ENCRYPTION_KEY 等 >=32 位随机值，
# 空值会让 API 容器拒绝启动）：
cp docker/.env.example docker/.env    # 填密钥
docker compose --env-file docker/.env up -d --build
```

`Dockerfile` 多阶段说明：

| 阶段      | 作用                                                                                          |
| --------- | --------------------------------------------------------------------------------------------- |
| `base`    | Node 22 + corepack + pnpm 11.5.1                                                              |
| `deps`    | `pnpm install --frozen-lockfile`（含各包 `prepare`：prisma generate / sdk / ui / 插件 build） |
| `build`   | `pnpm build`（含 `build:frontend` + `next build`）；`ARG API_BASE_URL` 影响构建期 CSP         |
| `prod-deps` | `pnpm install --prod --frozen-lockfile --ignore-scripts`（剔除开发期依赖，保留 Prisma CLI / Next / Tailwind / TypeScript / esbuild / Prettier 等运行期工具） |
| `runtime` | 安装 `postgresql-client-16`（自助导出/导入），复制 `prod-deps` 产物与入口脚本           |

`.dockerignore` 已排除 `node_modules`、`data/`、`.env*`、`.git` 等，构建上下文干净。

### 运行用户（非特权，安全审计 M-3）

`runtime` 阶段以基础镜像自带的 `node` 用户（uid/gid 1000）运行，不再以 root 启动。
`/app` 通过 `COPY --chown=node:node` 归属该用户，`/app/data` 与 `/opt/pnpm` 也已 chown。
新建的命名卷（`stackpanel-data`）会继承镜像中挂载点的属主，因此全新部署开箱即用。

> **升级注意**：若你从旧的 root 镜像升级，既有命名卷仍是 `root:root`，非特权进程无法写入。
> 升级时先对卷执行一次 chown，例如：
>
> ```bash
> docker run --rm -u 0 -v stackpanel-data:/data \
>   --entrypoint sh stackpanel:local -c 'chown -R 1000:1000 /data'
> ```

## 2. 发布（GHCR + tag + Release Notes + cosign）

发布由 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 完成：

- **触发**：推送 `v*` 标签（如 `v1.2.3`）；或手工 `workflow_dispatch`（只构建/推送/签名，不建 Release）。
- **推送目标**：
  - `ghcr.io/<owner>/stackpanel` —— api / worker / web 同一镜像（`release.yml`）
  - `ghcr.io/<owner>/stackpanel-updater` —— updater 独立服务（`publish-updater.yml`），
    **版本号必须与内核同号**：updater 协议由内核清单声明，跨号会让升级任务被拒
- **标签策略**（`docker/metadata-action` 的 semver 派生）：

  | 触发                    | 产出标签                                                      |
  | ----------------------- | ------------------------------------------------------------- |
  | `v1.2.3`                | `1.2.3`、`1.2`、`1`、`latest`、`sha-<短哈希>`                 |
  | `v1.2.3-rc.1`（预发布） | `1.2.3-rc.1`、`1.2`、`1`、`sha-<短哈希>`（**不含 `latest`**） |
  | 手工触发                | 输入的 `tag`、`sha-<短哈希>`（**不含 `latest`**）             |

- **平台**：`linux/amd64`、`linux/arm64`（Buildx + QEMU 多架构清单）。
- **附带证明**：同一 digest 上推送 **SBOM** 与 **SLSA provenance**（BuildKit `sbom: true` / `provenance: true`）。
- **签名**：cosign **keyless**（GitHub OIDC）。主镜像的签发身份绑定本仓库的 `release.yml`，
  updater 镜像绑定 `publish-updater.yml`——两者**不是同一份工作流**，`scripts/verify-image.sh`
  会按镜像名自动选对应身份（也可用 `STACKPANEL_IMAGE_WORKFLOW` 显式指定）。
- **Release Notes**：`v*` 标签推送时自动创建 GitHub Release，`generate_release_notes: true` 按提交历史汇总，
  正文追加镜像引用 / digest / 拉取与验签命令。预发布标签自动标 `prerelease`。

> 一次性前置：仓库需允许 Actions 写入 Packages（`permissions.packages: write`，工作流内已声明）。
> 首次发布后，把仓库可见性/包可见性设为 public（若希望匿名 `docker pull`）——
> **两个包都要设**：`stackpanel` 与 `stackpanel-updater`。漏掉后者时部署端 `docker pull` 会 401。

### 手工补发 / 重签

Actions → Release → Run workflow → 填 `tag`（如 `v1.2.3`）→ 运行。
它重跑构建/推送/签名，但**不**创建或修改 Release（Release 只在标签推送时生成）。

> 补发 **updater 镜像**要动 `Publish updater image` 这份工作流，不要用上面的 `Release`：
> `Release` 的手工触发会把 `stackpanel:1.2.3` 这类版本标签重新指向一个新摘要，而已签名的
> 内核清单里写死的是旧摘要，两边对不上就等于发布了一版没人能验过的镜像。
>
> ```bash
> # 按标签检出后构建：镜像内容与内核同号，且只动 updater 镜像
> gh workflow run publish-updater.yml --ref main -f tag=v0.1.1
> ```

## 3. 校验签名（`scripts/verify-image.sh`）

```bash
# 需要 cosign：https://docs.sigstore.dev/cosign/system_config/installation/
# 需要 docker（用于把标签解析成摘要）

bash scripts/verify-image.sh ghcr.io/<owner>/stackpanel:v1.2.3
bash scripts/verify-image.sh ghcr.io/<owner>/stackpanel-updater:v1.2.3   # 签发身份不同，脚本自动切换
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
- **updater 镜像**：`--image` 带了 `<tag>` 时会自动推导并写入
  `STACKPANEL_UPDATER_IMAGE=ghcr.io/<owner>/stackpanel-updater:<同一 tag>`，也可以用
  `--updater-image` 显式指定。**用摘要引用（`@sha256:`）时必须显式给**——摘要推不出同一版本的
  updater 镜像，不给就会退回本地标签并触发 `build`，违背「运行 Compose 不含 build」的基线。
- `STACKPANEL_VERIFY_IMAGE=1` 时先跑 `scripts/verify-image.sh` 校验签名（主镜像与 updater 各一次）；缺省只提示、不阻断。
- 后续手动运维可直接复用同一镜像：

  ```bash
  docker compose --env-file docker/.env up -d        # 读到 .env 里的 STACKPANEL_IMAGE
  ```

## 5. 反代模板（自建 nginx / Traefik / 面板）

仓库自带的 Caddy（`docker/Caddyfile`，compose 的 `https` profile）已经处理好路由。
自己挂反代（1Panel、宝塔、群晖、K8s Ingress）时**必须把 API 的 13 个前缀单独转发**，
漏一个就是「页面正常但插件前端 / 主题资源 / 支付回调 404」：

```
/api/v1   /api/product   /mcp   /sp/v1   /llm-gateway   /callbacks   /zjmf_api_login
/cart     /host          /provision   /themes   /plugins   /media   /platform
/health   /ready         /version
```

其余（含 Web 自己的 BFF：`/api/notifications`、`/api/llm-gateway/*`、`/api/catalog/*`、
`/api/store/*`）转发到 web(3000)。现成模板：

- `docker/proxy/nginx.conf.example`
- `docker/proxy/traefik.yml.example`
- `docker/Caddyfile`（compose 内置）

**协议头（最容易踩、症状最误导）**：`X-Forwarded-Proto` 必须送**访客看到的**协议，
不能写 nginx 的 `$scheme`。TLS 在 CDN / 面板终止、回源到 `listen 80` 时 `$scheme`
永远是 `http`，而浏览器的 `Origin` 是 `https://…`；Web BFF 的同源守卫
（`apps/web/src/lib/request-origin.ts`）比对不上就 403 —— 界面显示「请求来源无效」，
**后台所有 POST 全部失效**，但页面本身完全正常（GET 不受影响），几乎不会有人
联想到是反代。正确写法：

```nginx
map $http_x_forwarded_proto $sp_forwarded_proto {
    default $http_x_forwarded_proto;   # 优先透传 CDN 写的
    ''      $scheme;                   # 上游没写时才兜底
}
proxy_set_header X-Forwarded-Proto $sp_forwarded_proto;
proxy_set_header X-Forwarded-Port  $server_port;
```

（本站**只**经 CDN 的 TLS 暴露、且 CDN 不回写这个头时，把兜底那一行改成 `https`。）
Caddy 与 Traefik 自动处理这一项，只有手写 nginx 会错。

**API 前缀用 `^~`**：1Panel / 宝塔 的站点配置里常有 `location ^~ /api/`，nginx
先匹配 `^~` 再看正则，裸正则版本会被静默吞掉，`/api/v1/*` 全部落到 Web 上游 → 404。

**真实客户端 IP**：反代前面还有 CDN / 云负载均衡时，必须让反代信任那些回源网段
（nginx：`set_real_ip_from` + `real_ip_recursive on`；Traefik：`forwardedHeaders.trustedIPs`），
否则内核看到的所有访客都是同一个地址——按 IP 的限流、验证码冷却、封禁与审计会全部失真。
内核侧 `API_TRUST_PROXY` 默认 `loopback,linklocal,uniquelocal`（所有 RFC1918 私网），
容器网络里的反代本来就落在私网，因此通常不用改；公网伪造的 `X-Forwarded-For` 依旧无效。

## 6. 首次启动：管理员、信任根、版本

**信任根自动写入**：首启时内核把默认公钥（`catalog-2026` / `pkg-2026-11` / `kernel-2026-11`）
幂等写进 `<数据目录>/trust/keyring.json`，因此全新实例可以直接从市场安装插件/主题。
已存在的文件**绝不覆盖**（运维删掉的默认 key 不会被加回来；文件非法时只告警）。
市场安装报 `market.trustRootMissing` 时，就是该文件缺对应 keyId。

**无浏览器初始化管理员**（容器化 / CI 用；实例还没有任何管理员时才可用）：

```bash
# 有 STACKPANEL_SETUP_TOKEN 时带上；没有则不传 setupToken 字段
curl -fsS -X POST http://127.0.0.1:3001/api/v1/setup \
  -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"<强密码>","setupToken":"<令牌>"}'
# → 201 { token, user }，token 可直接当会话 Cookie 值 / Bearer 使用
```

**版本与自检**：`GET /version` 返回 `version / commit / builtAt / trustProxy / trust`
（信任根各用途公钥数量、`PACKAGE_SIGNATURE_REQUIRED` 当前值、keyring 的实际路径）。
启动日志也会打一行同样的横幅，容器里跑的是哪一次构建不用再靠行为猜。

## 7. 必须备份的路径

数据卷 `stackpanel-data`（容器内 `/app/data`）里放的是**不可再生的实例状态**：

| 路径 | 内容 | 丢失后果 |
| --- | --- | --- |
| `trust/keyring.json` | 信任根（目录/包/内核公钥） | 已装包的验签与内核升级全部失败 |
| `plugins/` | 已安装插件（含前端产物与私有配置） | 需重新安装，插件里的业务数据一并丢失 |
| `themes/` | 已安装主题 | 前台回到默认外观 |
| `distribution/` | 目录缓存、分发源配置 | 需重新拉取目录（不致命） |

数据库与对象存储分别在 `stackpanel-postgres` / `stackpanel-minio` 卷里，用
「系统设置 → 备份」导出（`pg_dump` + 对象存储清单）比 `docker cp` 更可靠。示例：

```bash
# 停写期间冷备（最稳）
docker compose stop api worker web
docker run --rm -v stackpanel_stackpanel-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/stackpanel-data-$(date +%F).tgz -C /data .
docker compose start api worker web
```

注意 `docker compose down -v` 会**删除全部卷**（含上面这些）；升级只用 `up -d`。

## 8. 健康检查端点

| 端点 | 用途 | 期望 |
| --- | --- | --- |
| `GET /health` | 存活探针（不碰依赖） | 200 `{"status":"ok","version":"…"}` |
| `GET /ready` | 就绪探针（真连 DB / Redis / 存储 / 待生成前端） | 200；任一不可用 → 503，body 里带具体项 |
| `GET /version` | 构建身份 + 信任根 + 反代配置 | 200 |

`/ready` 的响应里带 `memory: { heapUsed, heapTotal, heapLimit, rss }`（单位 MiB）。
容器被 OOM 打出 500 时往往连 `docker exec` 都进不去，这是唯一还能从外部看到的
内存视角；堆用到 `heapLimit` 的 85% 以上时会额外带 `memoryPressure: true`，
监控据此在 OOM **之前**报警。

编排里建议：`livenessProbe` 用 `/health`（快、不依赖下游），`readinessProbe` 用 `/ready`
（失败就把流量摘掉，而不是重启容器）。

### 内存：默认值与扩容公式

每个已装插件都会在 **web**（账号页 / 后台页的 RSC 渲染）和 **worker**（任务分发要
插件服务端处理器）里各常驻一份，所以内存需求随插件数量线性增长。默认值按「装 10+
个插件」给的，**不要再往下调**：

| 服务 | `mem_limit` | `--max-old-space-size` |
| --- | --- | --- |
| `web` | 2048m | 1536 |
| `worker` | 1600m | 1200 |
| `api` | 1024m | 768 |

三条规则：

1. **必须显式给堆**。不给 `NODE_OPTIONS` 时 V8 只取容器限额的 ~50%，259MB 的堆
   装 10+ 个插件直接 OOM（v0.1.1 线上事故）。留 1/4 给 off-heap（Buffer / 原生分配）。
2. **扩容公式**：`建议内存 = 基础值 + 已装插件数 × 128MB`，其中 web 基础 1024MB、
   worker 基础 800MB、api 基础 768MB。例如装 20 个插件：web 需
   `1024 + 20×128 = 3584MB`，把 `WEB_MEM_LIMIT=3584m` 与
   `WEB_NODE_OPTIONS=--max-old-space-size=2688` 一起调（堆 ≈ 限额 × 0.75）。
3. **看启动横幅**。api 与 worker 启动时都会打印
   `内存：heap <used>/<limit> MiB (total <n>) · rss <n> MiB`。`heapLimit` 明显小于
   `mem_limit` 的一半，就说明 `NODE_OPTIONS` 没生效。

## 9. 发布前冒烟（拉官方镜像，不本地构建）

每次发 tag 之后必须跑一遍——它会真的起一套 compose、装一个插件和一个主题、
再验静态资源与健康检查：

```bash
node scripts/release/smoke-image.mjs --image ghcr.io/<owner>/stackpanel:<version>
```

它断言的事（对应线上事故清单）：

1. `/` 200，且首页引用的前几个 `/_next/static/chunks/*.js` 都 200（镜像漏打 `.next/static` 会在这里死）；
2. `/health` 200、`/ready` 200、`/version` 200（版本 + 提交号 + 信任根计数）；
3. 全新数据卷首启后无需人工写 `keyring.json`（`/version` 的 `trust.packageKeys ≥ 1`）；
4. 无浏览器初始化管理员（`POST /setup`），未登录 `/api/v1/me` 仍是 401；
5. 启用内置 market 插件 → 从市场安装一个 isolated（M2）插件 → 最终 `active`，日志出现激活行；
6. 安装一个主题 → 前台首页 200 且仍能渲染。

常用参数：

```bash
# 换端口（同机已有实例时）
node scripts/release/smoke-image.mjs --image <ref> --web-port 18000 --api-port 18001
# 跳过需要外网的两步（市场安装），只验静态资源/健康/信任根
node scripts/release/smoke-image.mjs --image <ref> --offline
# 失败后保留栈便于排查（会打印 down 命令）
node scripts/release/smoke-image.mjs --image <ref> --keep
```

它用独立的 compose 项目名（默认 `stackpanel-smoke`）和一次性密钥，跑完自动
`down -v`，不会碰宿主上已有的实例与数据卷。

## 10. 升级：有执行器 / 无执行器两条路

`updater` 服务在 compose 里是**显式 profile**，默认不启动——它需要
`/var/run/docker.sock`（等价于宿主 root）与宿主 docker 组 GID，默认部署不该假设这两样
都在。两种升级方式选一种：

**A. 自动升级（需要 updater）**

```bash
docker compose --profile updater up -d          # 先起执行器
# 之后在 后台 → 更新中心 检查并投递
```

执行器不在时，更新中心的「投递」按钮会**置灰**并说明原因。这是刻意的：投递出去
的任务没有执行器认领，只会永远停在「已投递」（v0.1.1 线上投递 11 个包升级后的实际
状态，页面只有一行「独立执行器状态不可读」）。

**B. 手工升级（不需要 updater）**

```bash
# 1) 拉新镜像（版本号必须与内核同号）
docker compose pull

# 2) 迁移：一次性容器，必须在启动新版本之前
docker compose run --rm migrate

# 3) 重建
docker compose up -d
```

顺序不能反：`migrate` 用的是新镜像里的 schema，先 `up -d` 会让旧代码跑新库。
