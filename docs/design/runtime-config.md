# 运行期配置：从环境变量到数据库（ADR-0026 实施说明）

> 结论先行：**能用后台改的配置都在数据库里，改完立即对所有副本生效，不需要重启。**
> 环境变量只保留三类：引导（连库、数据目录、监听地址）、密钥与基础设施（JWT、
> 加密钥匙、Redis、对象存储）、以及进程启动前就要生效的少数选项。

## 1. 为什么改

改造前，内核的开关几乎只能通过 `.env` 配置：

- 容器/集群部署要把配置写死在 Compose/Helm 里，改一个验证码模式等于一次发版；
- 后台设置页只能看到平台信息、签名公钥这些零散项，运维根本不知道还有 59 个变量；
- `STACKPANEL_FRONTEND_SERVER_EXEC` 这类决定性配置**连文档都没有**，写错了表现为
  "插件装上去了，但设置页是空表单"，排查成本极高。

## 2. 机制

### 2.1 存储

可入库的运行期配置写在 `Setting` 表，键名 `config.<ENV_NAME>`，例如
`config.AUTH_CAPTCHA_MODE`。值是 JSON 标量（`"required"` / `5` / `true`），存的是
**解析后**的类型，因此数据库里看到的与运行期用到的完全一致。

### 2.2 读取：同步快照

内核里读配置的调用点遍布请求路径（签发会话、下发 cookie、校验验证码、限流、
媒体尺寸上限）。把它们逐个改成 `await` 会把异步性扩散到几十个签名里，风险远大于收益。
所以：

```
入口（apps/api/src/normal-start.ts、worker.ts）
  └── await loadRuntimeConfig()        // 启动时读一次 Setting → 进程内快照
        └── getConfig('X')             // 请求路径同步读快照；无覆盖则回落 env
```

因此 `getConfig()` **永远同步**，且在没有数据库覆盖时与直接读 `env.X` 等价。

### 2.3 写入：唯一入口 + 广播失效

| 动作 | 接口                         | 行为                                                                   |
| ---- | ---------------------------- | ---------------------------------------------------------------------- |
| 读   | `GET /admin/config`          | 返回白名单内每项的生效值、来源（`stored`/`env`/`default`）、环境变量值 |
| 写   | `PUT /admin/config/:name`    | 用 `envSchema` 同名字段校验 → 落库 → 更新本进程快照 → Redis 广播       |
| 回退 | `DELETE /admin/config/:name` | 删除覆盖行 → 回落环境变量 → 广播                                       |

广播走已有的运行期一致性通道（`runtime/coherence.ts`，`kind: 'config'`），其它副本
收到后重载快照，**下一个请求**就用新值。审计动作：`config.changed` / `config.reverted`。

通用接口 `PUT /admin/settings/:key` **拒绝**写 `config.*` 前缀（403）：它不做取值校验，
直接写会造出"存进去了但永远不生效"的行。

### 2.4 白名单

`apps/api/src/config/runtime-config.ts` 的 `RUNTIME_CONFIG_SPECS` 是**白名单**，
新增环境变量默认不可编辑。这样某天多加一个密钥类变量时，不会因为"忘了加黑名单"
而被无意暴露到后台。

当前可编辑 16 项：

| 组           | 键                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 认证与验证码 | `AUTH_CAPTCHA_MODE`、`AUTH_CODE_TTL_SECONDS`、`AUTH_CODE_MAX_ATTEMPTS`、`AUTH_CODE_SEND_PER_HOUR`、`AUTH_CODE_SEND_PER_HOUR_PER_IP` |
| 会话         | `SESSION_COOKIE_NAME`、`SESSION_TTL_SECONDS`                                                                                        |
| 媒体         | `MEDIA_MAX_UPLOAD_BYTES`、`MEDIA_VARIANTS_ASYNC`                                                                                    |
| 开放 API     | `OPEN_API_TOKEN_RPM`、`OPEN_API_TOKEN_CONCURRENCY`、`STACKPANEL_API_TOKEN_PREFIX`                                                   |
| 插件         | `PACKAGE_SIGNATURE_REQUIRED`                                                                                                        |
| 审计         | `AUDIT_LOG_RETENTION_DAYS`                                                                                                          |
| Agent        | `AGENT_PUBLIC_ORIGIN`、`AGENT_WEB_ORIGIN`                                                                                           |

## 3. 什么**不能**入库（必须留在进程外）

| 类别         | 变量                                                                                                                                                 | 原因                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 引导         | `DATABASE_URL`、`STACKPANEL_DATA_DIR`、`API_HOST`、`API_PORT`                                                                                        | 读库要先连库；数据目录与监听地址必须先于任何业务逻辑确定                                           |
| 密钥         | `JWT_SECRET`、`SETTINGS_ENCRYPTION_KEY`                                                                                                              | 签名钥匙/加密钥匙放进它保护的那个库等于没保护                                                      |
| 基础设施     | `REDIS_URL`、`STORAGE_*`（驱动、S3 端点/区域/桶/凭证、本地根、公开前缀）                                                                             | `initInfra()` 在 `buildApp()` 之前，失败即退出；加密它们又依赖 `SETTINGS_ENCRYPTION_KEY`，形成自指 |
| 启动期一次性 | `API_LOG_LEVEL`、`API_CORS_ORIGINS`、`API_TRUST_PROXY`、`API_COOKIE_SECURE`、`DATABASE_POOL_*`、`OTEL_*`、`METRICS_*`、`STACKPANEL_SETUP_MODE/TOKEN` | 在任何请求之前生效，此时配置快照还没建立                                                           |

另有几项虽然"可运行期读取"，但已有**专属存储与界面**，不再重复收进 `config.*`：
分发源（`distribution.catalogSource`，含仓库/渠道/分支/加速/token）、签名公钥
（`signing.publicKey`）、平台身份（`platform.info`）、更新策略、LLM provider。
自升级相关变量（`DISTRIBUTION_UPDATE_*`）暂留环境变量，因为它们驱动的是升级状态机，
迁移收益低而回归风险高。

## 4. 为什么「插件服务端执行」不入库

页面数据有两种形态：`{ finder, as }` 由包自己的代码求值，`{ fetch: { path }, as }` 由**宿主**
代发内核 GET。前者意味着在 web 进程里执行第三方代码，这是**包的可信度**问题，不是一个
"运行期取值"，因此它的唯一来源是插件清单（ADR-0024、契约 03 §3.1）：

- 内核在安装/升级时裁决：非内置包声明 `frontendExecutions: "server"` 直接 422
  （`apps/api/src/lib/plugins.ts`）；
- 生效值随 `GET /plugins/frontends` 一起下发（`serverExecution: 'allowed' | 'declarative'`），
  web 只读这一个字段，不再自己从环境变量推导信任。

把它做成后台可改的运行期配置会破坏这条边界：一个能一键打开的开关，等于把「安装了某个包」
和「允许它执行代码」解耦。所以 §2.4 的白名单里没有它。

对包作者的实际结论：页面需要初始数据时**优先用 `fetch`**——装上就有数据、不需要准入；
只有确实无法用一次 HTTP GET 表达时才用 `finder`。

## 5. 后台界面

设置页新增「运行期配置」一区：

- 按组列出 16 项，行标题是环境变量名（技术标识符，不做翻译）；
- 徽标显示来源：`已覆盖` / `环境变量` / `默认值`；已覆盖时同时显示环境变量里的值，
  便于判断"回退会回到什么"；
- 布尔项是 `true/false` 下拉，避免手打出无法解析的值；
- 「回退」按钮删除数据库覆盖；

错误码：`config.unknown_key`（404）、`config.invalid_value`（400），两者在 7 个语言
目录里都有文案（`error.config.*`）。

## 6. 测试

- `apps/api/tests/unit/runtime-config.test.ts`：DB 行 → 快照解析、DB 覆盖 env、
  非法值不污染快照、白名单外的键（`JWT_SECRET`/`DATABASE_URL`）被忽略。
- `apps/api/tests/integration/runtime-config-admin.test.ts`（真实数据库）：
  写入后**同进程 `getConfig()` 立即生效**、落库值等于解析后的类型、重载快照仍生效、
  非法值/未知键被拒、删除覆盖回退到环境变量、非管理员三个动词全部 403。
- `apps/web/tests/error-code-coverage.test.ts`：`config.unknown_key` / `config.invalid_value`
  在 7 个语言目录里都有文案。

## 7. 运维速查

```bash
# 看当前生效值与来源
curl -s $API/admin/config -H "Authorization: Bearer $TOKEN" | jq '.entries[] | {name,value,source}'

# 改一项（立即生效，所有副本）
curl -s -X PUT $API/admin/config/AUTH_CAPTCHA_MODE \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"value":"required"}'

# 回退到环境变量
curl -s -X DELETE $API/admin/config/AUTH_CAPTCHA_MODE -H "Authorization: Bearer $TOKEN"

```

升级到本版本时：数据库里没有 `config.*` 行 → 全部沿用环境变量，**行为不变**；
想从环境变量迁到数据库，只需在后台把值填一遍，然后从部署文件里删掉对应变量。
