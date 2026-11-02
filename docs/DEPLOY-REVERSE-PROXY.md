# 反向代理部署与自检

> **一句话**：这份文档的目标不是「给你一份能用的配置」，而是让「反代配得对不对」
> 从**靠人读文档 + 猜症状**，变成**一条命令生成、一条命令自检、错误在后台一眼可见**。

0.1.x 的线上事故里，四条里有三条的症状都伪装成了别的问题。下面每一节都以「你会
看到什么」开头，因为**症状是对的入口，配置项不是**。

---

## 0. 三十秒路径（面板用户先看这个）

```bash
# 1. 生成配置（替换成你的域名与拓扑）
node scripts/proxy-config.mjs --topology same-host --domain sp.example.com \
  --out /etc/nginx/conf.d/stackpanel.conf

# 2. 生效
nginx -t && nginx -s reload

# 3. 自检（一条命令跑完整的断言矩阵）
node scripts/proxy-verify.mjs --base https://sp.example.com
```

三条命令全绿就结束了。**不要**直接把 `docker/proxy/nginx.conf.example` 原样 include
进面板生成的站点配置里 —— 原因见 §2.1，那是这次事故的正题。

如果第 3 步报错，跳到 §5 的速查表；表里每一条都对应一个真实发生过的事故。

---

## 1. 你属于哪种拓扑

先回答一个问题：**TLS 在哪一跳终止？**

| 你在前面放了什么 | 拓扑名 | 关键差异 |
| --- | --- | --- |
| 什么都没放，nginx 直接对公网（含本机 certbot 证书） | `same-host` | `$scheme` 是对的 |
| 1Panel / 宝塔 / 群晖的反代，与 StackPanel 在同一台机器 | `container` | 反代在**另一个 docker 网络**，必须配真实 IP 网段 |
| Cloudflare / CloudFront / 云 LB | `cdn` | **`$scheme` 一定是错的**，回源是 http |
| 自建多级反代，你确定上一跳写了正确的头 | `passthrough` | 信任上游，风险自负 |

```bash
node scripts/proxy-config.mjs --topology <上面那个名字> --domain <你的域名>
```

生成器会把「协议策略、真实 IP 段、上游地址」按拓扑替换好，并在文件头写明这一种
拓扑的注意事项。`--json` 可以拿到机器可读的结果（给自动化用）。

---

## 2. 三种典型拓扑

### 2.1 反代是面板生成的（1Panel / 宝塔 / 群晖）—— 事故 A 的现场

**你会看到**：网站正常打开，样式也对；但**插件前端 404、主题资源 404、支付回调
404**。后台有时候还提示「请求来源无效」。

**根因**：面板会在站点配置里生成一条

```nginx
location ^~ / { include proxy/*.conf; }   # 1Panel / 宝塔 的典型形态
```

nginx 的路由优先级是：

```
=      精确匹配（最高）
^~     最长前缀，命中即止
~ ~*   正则，按文件出现顺序
前缀    最长匹配（最低）
```

只要面板那条 `^~ /` 存在，文件里**所有** `location ~ ^/(api/v1|mcp|…)(/|$)` 正则
**永远不会被尝试**，而且没有任何告警。于是所有 `/api/v1/*`、`/themes/*`、
`/plugins/*`、`/callbacks/*` 都落到 Web 上游 → 404。

**修复**：把前缀规则全部改成 `^~`。`^~ /api/` 比 `^~ /` 更长，按最长前缀比较，
所以照样优先。仓库里的模板现在**一条正则都没有**，`sp-common.conf` 是唯一真源，
`apps/web/tests/proxy-template-routing.test.ts` 会真起 nginx + 一个「面板形态」的
server 逐条断言路由归属 —— 有人改回正则，CI 立刻红。

**面板食谱**（配置落在哪个文件、怎么插）：

| 面板 | 插在哪 | 必读陷阱 |
| --- | --- | --- |
| 1Panel | 站点 → 配置文件，插在 `include /www/sites/<name>/proxy/*.conf;` **之前** | 面板的 `proxy/root.conf` 里那条 `X-Forwarded-Proto $scheme` 会在你点「保存反代」时被重写；改**面板外**的 include 才持久 |
| 宝塔 | 站点 → 设置 → 配置文件，插在 `location ~ .*\.(php…)` 之前 | 宝塔会自动加 PHP 正则块；`^~` 规则只要更长就赢，但别把 API 规则放进那个正则块里 |
| 群晖 DSM | 反向代理 → 自定义标题 → 新增 `X-Forwarded-Proto: https` | DSM 没有片段 include，只能在「自定义标题」里加头；协议头必须手工加 |
| K8s Ingress | 多条 `path` + `pathType: Prefix` | **不要**开 `nginx.ingress.kubernetes.io/use-regex`；`proxy-body-size` 要调大（插件包可达数十 MB） |
| Cloudflare / CDN 前置 | 源站 nginx 加 `set_real_ip_from <CDN 段>` + 用 map 兜底协议 | CDN 回源是 http，`$scheme` 永远错；CDN 的 CC 防护可能把回源当攻击封掉，需把回源段加白 |

**改动如何生效**：`nginx -t && nginx -s reload`。**不要在面板里点「保存」** ——
面板会用自己的模板重写站点配置文件，把 include 覆盖掉。

### 2.2 TLS 在 CDN / 面板终止 —— 事故 B 的现场

**你会看到**：页面完全正常（GET 都好），但**后台所有 POST 失败**，界面提示
**「请求来源无效」**。开启 Agent、保存设置、改密码全部无效。

**根因**：模板/面板用

```nginx
proxy_set_header X-Forwarded-Proto $scheme;    # 错
```

`$scheme` 是 nginx **自己这一跳**的协议。TLS 在 CDN 终止、回源到 `listen 80` 时它
永远是 `http`；浏览器 `Origin` 是 `https://…`。Web BFF 的同源守卫
（`@stackpanel/sdk` 的 `isSameOriginRequest`）比对 `Origin` 的 scheme 与
`X-Forwarded-Proto`，不一致就 403。GET 不走这个守卫，所以页面看着是好的 ——
这就是它难查的原因。

**修复**：

```nginx
map $http_x_forwarded_proto $sp_forwarded_proto {
    default $http_x_forwarded_proto;   # CDN 写了就用它的
    ''      https;                     # CDN 没写，按对外协议兜底
}
proxy_set_header X-Forwarded-Proto $sp_forwarded_proto;
```

生成器的 `--topology cdn` 就是这段。`--edge-proto https` 可强制写死。

### 2.3 反代在另一个 docker 网络 —— 事故 C 的现场

**你会看到**：**所有人被认成同一个 IP**。表现为「整站被限流」「换个浏览器也提示
操作太频繁」「审计日志里只有一条 IP」「封禁一个人等于封站」。

**根因**：反代容器（1Panel 的 `172.18.0.x`）与内核不在同一网段，而
`API_TRUST_PROXY` 没包含它。内核于是把**反代地址**当成访客地址。

```nginx
# 反代这一侧
set_real_ip_from 172.18.0.0/16;   # 面板反代容器所在网段
real_ip_header   X-Forwarded-For;
real_ip_recursive on;
```

```bash
# 内核这一侧
API_TRUST_PROXY=loopback,linklocal,uniquelocal,172.18.0.0/16
```

两处都要改：`set_real_ip_from` 决定 nginx 往 `X-Forwarded-For` 里写什么，
`API_TRUST_PROXY` 决定内核愿不愿意采信它。

**安全的说法**（值得写进工单回复）：`trustProxy` 只影响「对端确实是受信代理时
才采信 `X-Forwarded-For`」。公网直连的伪造毫无作用，因为它的对端不在信任列表里。
`API_TRUST_PROXY=false` 是逃生开关（完全忽略这个头）。

---

## 3. 配置完之后怎么自查

### 3.1 一条命令：`proxy-verify.mjs`

```bash
node scripts/proxy-verify.mjs --base https://sp.example.com
```

它从**外部**打你部署好的站点，断言矩阵：

| 断言 | 判定 | 失败意味着 |
| --- | --- | --- |
| `GET /` = 200，且页面引用的前 3 个 `/_next/static/chunks/*.js` 均 200 | 静态资源可达 | 面板把资源转错了 |
| `GET /health` = 200 且 `content-type: application/json` | API 前缀命中 | 前缀漏配或被 `^~ /` 吞掉 |
| `GET /themes/<已装主题>/theme.css` = 200 | 资源前缀命中 | 同上 |
| `GET /ready` 里 `proxy.trusted = true` | 真实 IP 生效 | `API_TRUST_PROXY` 或 `set_real_ip_from` 没配 |
| `GET /version` 返回 `version` | 构建身份可达 | `/version` 前缀没转发 |
| `GET /api/v1/system/proxy-check` 里 `originGuardWouldPass = true` | 协议透传正确 | `X-Forwarded-Proto` 错（事故 B） |
| `GET /notifications/stream` 首字节 < 3s 且持续 > 10s | SSE 未被缓冲 | `proxy_buffering on` 或 gzip 压了 `text/event-stream` |

需要管理员的部分（`proxy-check`）用 `--token <admin token>`；不给就跳过并提示。

### 3.2 后台上看一眼：系统设置 → 反代自检

管理员打开 **系统设置 → 反代自检**（`GET /api/v1/system/proxy-check`）。它把内核
**实际看到的东西**摊开，每条不通过的项直接给出可执行的修复动作与本文档锚点：

- 协议透传（`X-Forwarded-Proto`）
- 真实客户端 IP（`X-Forwarded-For` 有没有被采信）
- 同源判定（后台 POST 会不会被 403）
- 前缀路由

**这个面板由浏览器直接请求内核**，因为要观测的正是「浏览器 → 反代 → 内核」这一跳。
走 BFF 会测成「web → api」内网直连，永远没有转发头，结果全绿而实际是坏的。

面板的判定结论与 Web BFF 用的是**同一个函数**（`@stackpanel/sdk` 的
`checkOrigin` / `isSameOriginRequest`），所以不会出现「诊断说通过、真实请求 403」——
那比不诊断更糟。

### 3.3 探针里也有：`GET /ready` 的 `proxy` 子项

```json
{
  "status": "ready",
  "proxy": { "trusted": true, "clientIp": "203.0.113.9", "peer": "172.18.0.5", "proto": "https" }
}
```

不需要登录，面板的健康检查与同机 `curl` 都能看到。`trusted=false` 且实际有
`X-Forwarded-For` 就是事故 C 的现场。

`GET /version` 另有 `trustProxy`（生效的 `API_TRUST_PROXY` 归一化值）与信任根计数，
用来回答「这个容器跑的是哪一次构建、生效的反代配置是什么」。

---

## 4. 单端口模式（最省事）

```bash
# docker-compose.yml 的 web 服务，或 .env
STACKPANEL_SINGLE_PORT=1
```

打开后 Web 会自己把内核的机器面前缀（`/api/v1/`、`/themes/`、`/plugins/`、`/mcp`、
`/hooks`、`/callbacks/` …）转发给内核，于是**反代只需要一个 upstream（3000）**。
事故 A 的「前缀漏配 / 被面板 `^~ /` 静默吞掉」整类问题从此不存在 —— 没有前缀可漏。

此时反代配置就是最朴素的形态：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    include /etc/nginx/snippets/sp-headers.conf;   # 协议与真实 IP，见 §2.2 / §2.3
}
```

**默认关闭**，因为它改变了两个上游的边界（原本由反代区分「哪些路径归 API」），把这段
职责从部署配置搬进了代码。现有部署的语义不变，所以不默认开。

关闭时（默认）你需要按 `docker/proxy/sp-common.conf` 把内核前缀单独转发给 3001。

### 实现说明（排查时会用到）

转发发生在 `apps/web/src/proxy.ts` 的 middleware 里，判定表在
`apps/web/src/lib/single-port.ts`。**不在** `next.config.ts` 的 `rewrites()` 里 ——
后者在 `next build` 时就被内联进 `.next/routes-manifest.json`，运行时设环境变量
完全没有效果（实测：镜像里的 manifest 只有 `/media` 一条）。所以：

- 改这个开关只需重启 web 容器，不需要重新构建镜像；
- 判定表里 Web 自己的 BFF 前缀（`/api/account`、`/api/agent`、`/api/notifications`、
  `/api/plugins`、`/api/store`、`/api/frontend-abi`、`/api/action-flash`、
  `/api/admin`）优先于内核前缀，登录/通知/插件后台不会被抢走；
- 新增一个 BFF 目录时必须同步更新那份清单，`apps/web/tests/single-port-routing.test.ts`
  会对着 `src/app/api/` 的文件系统核对，漏改即红。

选它之前先确认：Web 与内核之间的网络延迟足够低（同机 compose 没问题），且你不依赖
「API 与 Web 分别在不同域名」的布局。

---

## 5. 症状 → 根因 → 修复（最有用的一页）

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| 页面正常，但**插件前端 / 主题资源 / 支付回调 404** | API 前缀没转发，或被面板的 `location ^~ /` 吞掉正则 | 16 条规则全改 `^~` 前缀（§2.1） |
| **「请求来源无效」** / 后台保存设置失败 / Agent 开不起来（GET 都正常） | `X-Forwarded-Proto` 是 `http`，浏览器 `Origin` 是 `https` | 用 `$sp_forwarded_proto` map 兜底（§2.2） |
| **所有人共用同一个 IP**，限流误封整站 | 反代网段未被信任 | `set_real_ip_from` + `API_TRUST_PROXY`（§2.3） |
| **SSE / 进度条不动**、备份下载卡住 | `proxy_buffering on` 或 gzip 压了 `text/event-stream` | `proxy_buffering off`；不要 gzip `text/event-stream` |
| 上传插件包 **413**，内核侧无任何日志 | `client_max_body_size` 默认 1m | 调到 `512m`（模板已含） |
| 后台登录后**随机掉线** | 协议/端口不一致导致 cookie 域或 Secure 属性错配 | 同上 §2.2；确认 `X-Forwarded-Port` 与 `API_COOKIE_SECURE` |
| `/version` **404** | 该前缀没转发 | 加 `location ^~ /version`（模板已含） |
| `nginx -t` 报 `host not found in upstream` | 上游服务名在当前 docker 网络里解析不了 | 改用宿主地址 `--web-upstream` / `--api-upstream`（§2.3 的表） |
| 面板「保存」之后配置又变回去了 | 面板用自己的模板重写了站点配置 | 改 include 文件，**不要在面板里点保存**（§2.1） |

---

## 6. 迁移与回滚

- 只改 nginx：`nginx -t && nginx -s reload`。无需重启 StackPanel。
- 改 `API_TRUST_PROXY`：`docker compose up -d api worker`（两个服务都要）。
- 回滚：把生成的文件删掉、恢复面板原配置、`reload`。内核侧把 `API_TRUST_PROXY`
  改回默认即可 —— 这些改动都不动数据。

---

## 7. 相关文件

| 文件 | 作用 |
| --- | --- |
| `docker/proxy/nginx.conf.example` | nginx 模板（唯一真源，含 `__SP_*__` 占位符） |
| `docker/proxy/sp-common.conf` | 共享前缀片段（三份模板共用的前缀契约） |
| `docker/proxy/traefik.yml.example` | Traefik v3 模板（priority 语义见文件注释） |
| `docker/Caddyfile` | compose 内置 Caddy（`profile: https`），已含 `trusted_proxies` |
| `scripts/proxy-config.mjs` | 生成器（拓扑 → 完整配置，含 CDN 回源段） |
| `scripts/proxy-verify.mjs` | 部署后自检（断言矩阵） |
| `apps/web/tests/proxy-template-routing.test.ts` | 真跑 nginx 的路由回归（面板形态下逐条断言） |
