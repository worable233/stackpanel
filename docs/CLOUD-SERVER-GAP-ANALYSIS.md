# 云服务器产品类型 · 全生命周期对标分析

> 对标对象：智简魔方 V10 业务系统（`docs.idcsmart.com` 「商品管理」「业务管理」）。
> 结论均以本仓库源码为证据，标注文件与位置。本文件为后续迭代基线。

## 一、总体结论

**骨架完整、闭环不全。**

`商品 → 下单 → 支付 → 开通 → 电源管理 → 监控` 主链完整且工程化（异步履约队列、
重试退避、密钥托管、集群任务）。但作为「云服务器业务系统」，**续费、升降级、
到期自动化、退款** 四大商业化闭环缺失；VPS 运维（重装/重置密码/VNC/快照/
弹性 IP/流量计费）缺失；**按需计费、资源包、弹性云动态配置** 等未实现。

> 关于上游对接插件源码：`zjmf-upstream` / `zjmf-compat` 的 **TypeScript 源码位于
> 独立仓库 `worable233/stackpanel-plugins`**（与内核仓同级的工作区），
> 本仓库 `data/plugins/**` 仅为其构建产物（`dist/`）。因此「无源码」不成立。

## 二、已实现（可直接对标魔方）

| 环节 | 现状 | 证据 |
|---|---|---|
| 商品组（二级树）/商品 CRUD | ✅ | `packages/plugins/store/src/categories.ts`、`products.ts` |
| 商品类型 + 动态配置字段 | ✅ | `packages/sdk/src/fulfillment.ts`（ProductTypeProvider）；`packages/plugins/store-product-server/src/index.ts` |
| 周期与价格（月/年 + 续费价 + 货币） | ✅ | `store/src/utils.ts`（cycles）；`pricing.ts` |
| 库存（原子预留/回补/防超卖） | ✅ | `store/src/repository.ts`、`orders.ts` |
| 购物车（增删改/多件/持久化） | ✅ | `store/src/cart.ts` |
| 订单 + 余额/网关支付 + 取消/回补库存 | ✅ | `store/src/orders.ts`（PENDING/PAID/CANCELLING/CANCELLED） |
| 履约 SPI + 异步任务队列 + 重试 + 密钥托管 | ✅ | `packages/sdk/src/fulfillment.ts`、`store/src/fulfillment.ts` |
| 服务实例 suspend/resume/terminate/delete | ✅ | `store/src/operations.ts`、`fulfillment.ts` |
| 续费（余额下单 → 顺延到期 + 恢复服务） | ✅ | `store/src/renewal.ts`、`store/src/index.ts`（`POST /services/:id/renew`） |
| 到期自动化（提醒→暂停→终止，含宽限/保留期） | ✅ | `store/src/expiry.ts`、`store/src/repository.ts`（`listExpiringServices`）、`store/src/index.ts`（扫描 job） |
| 退款（退回余额 + 回补库存 + 订单置 REFUNDED） | ✅ | `store/src/refund.ts`、`store/src/index.ts`（`POST /store/admin/orders/:id/refund`） |
| VPS 运维动作（重装/重置密码/控制台 + 电源） | ✅ | `store-product-server/src/index.ts`（原生）；`store/frontend/src/index.tsx`（参数表单）；zjmf 桥接见下 |
| 运维动作 SPI（参数声明 + 返回结果/runtime） | ✅ | `packages/sdk/src/fulfillment.ts`（`ServiceActionParam`/`ServiceActionResult`、`executeAction(actionId, ctx, params)`） |
| 「我的云服务」详情/监控图表/动作 | ✅ | `store/frontend/src/index.tsx` |
| 上游对接（魔方 finance+v10）、产品同步、绑定、加价、开机/关机/重启/终止、监控 | ✅ | `stackpanel-plugins/packages/plugins/zjmf-upstream/src/**` |
| 上游 VPS 动作（重装/重置密码/VNC）桥接 | ✅ | `zjmf-upstream/src/provider.ts`、`zjmf-client.ts`（`runServiceAction(..., params)`） |
| 上游反向协议适配（被 WHMCS/魔方客户端对接） | ✅ | `stackpanel-plugins/packages/plugins/zjmf-compat` |
| 工单 / 通知 / 发票 / 应用市场插件 | ✅（依赖安装） | `data/plugins/{ticket,notice,invoice,catalog}` |
| 集群化定时任务调度 | ✅ | `apps/api/src/jobs/kernel-jobs.ts`、`store/src/index.ts`（`ctx.jobs.schedule`） |

## 三、缺口清单

### 3.1 商业化闭环（P0）

| 能力 | 魔方 V10 | StackPanel | 证据 |
|---|---|---|---|
| 续费 | 订单续费、周期设置、到期续费 | ✅ 已实现（余额续费下单 → 顺延到期 + 恢复服务；退款/取消跳过续费行） | `store/src/renewal.ts`；测试 `store/src/renewal-expiry.test.ts` |
| 升降级/变更规格 | 计算/存储可变更，按需支持升降级 | ❌ | grep `upgrade` 仅命中插件热升级 |
| 到期自动化 | 宽限期→保留期→删除，短信/邮件提醒 | ✅ 已实现（提前 7d 提醒→宽限 3d→暂停→保留 7d→终止；扫描 job 集群单次执行） | `store/src/expiry.ts` |
| 退款 | 交易流水可删改、退款 | ✅ 已实现（退回钱包结算币 + 回补库存 + 订单置 REFUNDED + 审计流水） | `store/src/refund.ts`；测试 `store/src/refund.test.ts` |
| 订单状态机 | 含已退款/已完成/已过期 | ⚠️ 已补 `REFUNDED`（后端置态 + UI 徽标）；`EXPIRED/COMPLETED` 仍为 UI 标签 | `store/src/refund.ts`；`store/frontend/src/index.tsx` |

### 3.2 VPS 运维能力（P1）

| 能力 | 魔方 | StackPanel | 证据 |
|---|---|---|---|
| 重装系统 | ✅ | ✅ 原生动作（选系统参数）+ zjmf 上游桥接 | `store-product-server/src/index.ts`、`zjmf-upstream/src/provider.ts` |
| 重置服务器密码 | ✅ | ✅ 原生动作（新密码入 runtime + 返回展示）+ zjmf 桥接 | 同上 |
| VNC/控制台 | ✅ | ✅ 动作返回控制台地址；zjmf 提取上游 URL | 同上 |
| 电源管理（开/关/重启） | ✅ | ✅（原生 + zjmf） | 同上 |
| 快照/备份（服务器级） | ✅ | ❌（仅平台 DB 备份 `apps/api/src/backup/*`） |
| IP 管理/弹性 IP | ✅ | ⚠️ 只读展示 | `zjmf-upstream/src/provider.ts` getDetail |
| 流量/带宽配额与计费 | ✅ | ⚠️ 只读指标 | 同上 getMetrics |
| OS 镜像动态拉取 | ✅ | ⚠️ 固定候选；重装参数已预留（可改为动态） | `store-product-server/src/index.ts` |

### 3.3 商品与计费模型（P1/P2）

按需计费（后付费，按分钟/小时结算，宽限期/保留期/最低余额/初装费）、弹性云动态
配置（计算/数据中心/存储/OS）、资源包、物理机/机柜、初装费、优惠券/促销、税 —— 均缺失。

### 3.4 财务与售后（P2）

发票用户端（申领/抬头/收件地址，当前 invoice 插件仅管理端）、交易流水、提现、
独立账单模型 —— 缺失。

## 四、优先级

- **P0**：续费下单流程 → 到期扫描 job（提醒→暂停→终止，含宽限期）→ 退款 → 订单状态机补齐。
- **P1**：经 `executeAction` SPI 扩展重装/重置密码/VNC；`getMetrics` 之上做流量配额；数据中心/节点/线路 + OS 镜像模型。
- **P2**：升降级 → 按需计费 → 优惠券/税/发票用户端/交易流水。

## 五、复审与修复（第二轮）

对本轮实现做了一次逐行复审，发现并修复以下问题：

| # | 问题 | 修复 |
|---|---|---|
| 1 | 续费只顺延到期，未恢复被暂停服务 | `renewal.ts`：`applyRenewalOrder` 对 `SUSPENDED` 服务调 `resume` 并置回 `ACTIVE` |
| 2 | 正常开通的服务无初始 `expiresAt`，到期自动化对其失效 | `utils.ts#initialExpiryAt` + `fulfillment.ts`：按结账周期落初始到期时间 |
| 3 | 退款不撤销续费、部分退款不动物库存 | `refund.ts`：全额退款回滚续费顺延（`reverseRenewalOrder`）并回补库存；部分退款仅退金额 |
| 4 | 运维动作参数可覆盖上游保留字段（`func`/`action`） | `fulfillment.ts` 仅放行动作声明参数（含 JSON 参数袋）；`zjmf-client.ts` 保留字段置后 + `provider.ts` 二次校验 |
| 5 | 动作返回值（VNC 地址/新密码）被前端丢弃 | 控制台地址落 `runtime.consoleUrl`，详情可展示/点击 |
| 6 | 平台 action `input` 静态，仅 `os`/`password` | 新增通用 `params`（JSON 对象字符串）参数袋 + 前端「附加参数」输入，支持任意声明参数 |
| 7 | 新增 `StoreError` 文案未登记稳定错误码 | `errors.ts` 补齐 9 个错误码 |
| 8 | `claimExpiryStage(id, null, …)` 条件过宽 | 改为 `expiryStage IS NULL` |
| 9 | 到期扫描整行覆盖写，丢并发更新 | 新增 `patchServiceInstance`，仅按条件 patch 状态字段 |

测试：store 32、store-product-server 6、zjmf-upstream 20，均通过。

## 六、修订记录

- 初版：基于源码实测（grep/读码）产出；更正了「上游插件无源码」的误判。
- 二轮：复审并修复上述 9 项（含 2 项「实现与宣称不符」的功能缺陷、1 项安全面）。
