# 商店退款闭环 TODO

原则：任何不确定的支付、上游履约或实例处置状态均拒绝自动退款；目前实际退款目的地只支持 StackPanel 钱包，绝不把钱包入账描述为支付渠道原路退回。每项实施后逐项打勾并记录验证。

> 状态标记：`[x]` 已实现且已验证 · `[~]` 已实现但有路径未真实验证 · `[ ]` 未实现。每条后面的「验证」是实际做过的动作，不是计划。

---

## 一、本轮新增：实例页退款（服务级）

客户在云服务详情页申请退款，与订单页退款共用同一张申请表和同一个审核队列。

设计约束（都是刻意的）：

- **政策默认关闭**（`enabled: false`）。退款是花钱动作，升级不能凭空给存量部署打开一个自动退款入口。
- **金额只由服务端算**。资格查询与真正退款共用同一份推导，客户端传的 `amount` 被忽略；页面上展示的可退金额 = 实际退款金额。
- **先停用再落申请**。停不掉就不建申请，否则「申请存在但机器还在跑」是最坏的「已承诺未执行」。
- **钱先退、机器后停**。停服失败不能让客户拿不到已批准的钱；失败只写回 `terminateError` 并告警 admin，绝不把退款结论改回失败（那会诱导运营重复退款）。
- **驳回必须恢复实例**。申请时关过机，驳回没还回去 = 「拒绝退款」顺手把客户服务停了。
- **审核时才读最新政策**，不用申请时的快照，以免逆着运营最新意图动手。

已完成并**真机验证**：

- [x] 政策模型与默认关闭：窗口三态（`null` 永久 / 正数天数 / `0` 一律不可）、金额模式（全额 / 按未使用时长比例）、手续费 bps、申请即停用、通过后停服、一单一次。落 `store-provisioning-policy` secrets。
  - 验证：`packages/plugins/store/src/refund-policy.test.ts`（12 条）、`settings.test.ts`（7 条：默认含 refund、旧记录升级不打开退款、单独保存 refund 不覆盖 mode、坏 JSON 回落默认）。
- [x] 服务端唯一权威金额推导 `evaluateServiceRefund`：政策开关 / 无订单 / 归属不一致 / 订单状态 / 合作方预付 / 已终止 / 开通中 / 窗口为 0 / 超窗 / 一单一次 / 可退额为 0 全部 `deny(reason)`。
  - 验证：真机 `GET /services/:id/refund-eligibility` → `eligible:true`、`refundableAmount:6536`、`orderAmount:6635`、`windowEndsAt:2026-11-05T05:40:04Z`。
- [x] `POST /services/:id/refund-requests`：先 `runServiceLifecycle(service,'suspend')` 并 `updateWhere(state: SUSPENDED)`，成功后才建申请；停用失败抛 `502 实例停用失败` 且不留申请；金额取服务端推导值。
  - 验证：真机两次申请，`serviceSuspended:true`，DB `ext_store_service-instance` 的 `state:SUSPENDED`，机器 `:22` CLOSED。
- [x] 审核驳回 → `resumeServiceAfterReject`：`resume` + `updateWhere(state: ACTIVE)`；`resume` 失败只 warn + 通知 admin `store.refund.resume-failed`，不回滚驳回结论。
  - 验证：真机两次驳回，机器两次恢复（`:22` OPEN、ping 0% loss），`state` 回 `ACTIVE`。
- [x] 审核通过 → `terminateServiceAfterApprove`：先 `refundOrder` 入钱包，再 `terminate`（财务协议走 `host/cancel` 申请停用）；停用失败写 `terminateError` + 通知 admin `store.refund.terminate-failed`，退款结论保持 `SUCCEEDED`。
  - 验证：**仅单元测试**（`refund-service.test.ts` 审核 4 条，含 terminate 失败分支）。真实路径未跑，见下方「未验证」。
- [x] 详情状态不能被上游「业务状态」盖掉：上游 `host/list` 的 `domainstatus:"Active"` 与电源无关（`power_off` 后仍报 Active，`provision/default func=status` 返回 `null`，`provision/custom func=status` 400）。本地 `SUSPENDED`/`TERMINATED` 现在压过上游，且**同步改写 `detail.status`/`detail.statusLabel`**（前端渲染的是 `detail`，只改顶层字段看不到）。
  - 验证：真机 `status= SUSPENDED`、`detail.status= SUSPENDED`、`detail.statusLabel= null`；驳回后三者全部回 `ACTIVE`/`已激活`。
- [x] admin 退款队列显示「实例页申请」标识 + 停用失败提示（`terminateError`），历史订单退款行不带标识。
  - 验证：浏览器实看 `/admin/plugin/store/refunds` → `823e590d… 实例页申请 cmvq80eyf… ¥65.34 已拒绝`，`255a1060…` 行无徽章。
- [x] 前端实例详情页新增「退款」面板：可退金额（只读服务端值）、截止日期或「随时可申请」、原因输入、申请按钮；PENDING / REJECTED（带 `reviewReason`）/ SUCCEEDED 三态。
  - 验证：SSR 抓页面出现「可退金额」「退款」；PENDING / SUCCEEDED 卡片**未在页面上看过**，见下方「未验证」。

---

## 二、未验证（需要真实或不可逆动作才能验）

按风险从高到低。每一条都写清了「怎么验 / 代价」。

### 1. approve 全路径真实 e2e — 未跑

- **未验**：`POST /store/admin/refund-requests/:id/review {decision:'approve'}` 在真实订单上完整走通：钱包 `+6534` 入账 → `terminate` 向上游 `host/cancel` 提交停用申请 → 申请落 `SUCCEEDED + terminateApplied:true` → 实例 `TERMINATED`。
- **只验到**：单元测试 4 条（approve 成功、terminate 失败不改退款结论、驳回恢复、重复审核 409）。
- **代价**：钱包入账可在同一用户名下对冲（客户和运营都是测试账号，实际无损失），但 `host/cancel` 是**不可逆**的停用申请 —— 提交后上游人工审核通过，机器就没了。当前已验证用的主机是 `33363`（`156.233.230.86`）。
- **结论**：等运营/用户明确点头再跑，或另开一台一次性机器专门验这一条。

### 2. 停用失败不建申请（502 分支）— 未真实复现

- **未验**：`runServiceLifecycle(service,'suspend')` 抛错时，`POST /refund-requests` 返回 502 且**数据库里没有留下申请**。
- **只验到**：单测 mock 了 throw。真机上没制造过上游 `power_off` 失败。
- **怎么验**：把 `providerServiceId` 指向一个不存在的上游主机 id，再申请退款。

### 3. 驳回时开机失败的告警链 — 未真实复现

- **未验**：`resume` 失败 → 实例停在 `SUSPENDED`、admin 收到 `store.refund.resume-failed` 站内信、驳回结论仍然生效。
- **只验到**：单测 mock。
- **代价**：需要一台「关机成功但开机失败」的机器，不可控，通常只能靠 mock。

### 4. 政策窗口边界在真实时间上的行为 — 未验

- **未验**：`windowDays` 设为 1 天后超窗拒绝、设 `0` 一律不可、设 `null` 永久可申请 —— 三条在真实时钟下走一遍。
- **只验到**：单测用 `vi.useFakeTimers()` 固定在 `2026-01-15`。
- **怎么验**：改政策 → `GET /refund-eligibility` 看 `reason`。便宜，但没有运行中的退款单需要它，一直没排。

### 5. 按未使用时长比例的真实金额 — 未验

- **未验**：`amountMode:'prorated'` 在一张有真实账期（`periodStart`/`periodEnd`）的订单上算出的金额与人工核算一致。
- **只验到**：单测 8 条（含「到期后退 0」「开通前退全额」「无账期按全额」）。真机上一直是 `full` 模式（`6536 / 6635` 差额来自手续费）。

### 6. 前端退款面板的 PENDING / SUCCEEDED 两态渲染 — 未在页面上看过

- **未验**：申请提交后刷新页面看到「审核中」卡片、审核通过后看到「已退款」卡片。
- **只验到**：REJECTED 数据在 RSC payload 里、徽章在 admin 侧渲染正常；前台只看到过「立即可申请」态。
- **怎么验**：提一单不审核，直接打开详情页截图；SUCCEEDED 需要 approve（见第 1 条）。

### 7. 后台退款政策表单的浏览器往返 — 未点过

- **未验**：`StoreSettingsPage` 三态窗口切换、4 个字段、3 个 checkbox（`onCheckedChange` 那次修复）真实保存并回显。
- **只验到**：`POST /store/admin/settings` 用 curl 打开过 `enabled:true` 并回显正确；`tsc` 通过。
- **风险点**：`@stackpanel/ui` 的 `Checkbox` 是 Radix `CheckboxRoot`（无原生 `onChange`），修复后没在浏览器里点过一次。

### 8. 前台「退款」入口在其它 locale / 窄屏下的表现 — 未验

- **未验**：`zh-HK` / `zh-TW` / `en-US` 三份文案（各 +30 键，store 共 548 keys）在页面上正确显示；移动端 panel 切换条不挤爆。
- **只验到**：`check-package-catalogs.mjs` 键集合校验通过。

---

## 三、订单页退款（订单级，早前已完成）

- [x] 持久退款申请记录与状态机：待审核、已拒绝、退款中、已退至钱包、执行失败；申请人/审核人/原因/金额/时间可审计。
- [x] 用户仅可为本人已付款且未退款的订单申请，验证累计可退金额；已申请/处理中金额占用额度防并发超退。
- [x] 管理员列表、详情、拒绝和批准路由校验权限、订单归属、状态与乐观锁；重复批准仅执行一次。
- [x] 钱包退款按退款申请唯一 ID 幂等入账；部分退款累计正确，全部退完才终结订单，旧订单无字段时兼容为 0。
- [x] 对账单明确实际入账目的地为平台钱包；合作方预付/金额币种异常/订单状态异常拒绝。
- [~] 对履约结果未知、开通中、运行中的实例阻止批准；不自动删除上游实例。失败申请可见原因并可安全重试，不重复入账。
  - 未验：`needs_upstream_attestation` 那次「运营确认无上游实例」的真实点击（`window.confirm` 路径只在代码里）。
- [x] 用户申请、管理员审核、成功/失败站内通知可恢复投递；事务外副作用以持久状态驱动重试。
- [x] 退款审计记录操作者、订单、申请、金额、币种、目的地、结果及原因，不记录敏感凭据。
- [x] 直接退款必须顺手关掉同一订单上还开着的退款申请（同一事务）——`6f35d73`。
- [x] `FAILED` 不是终态：`PENDING|FAILED` 都可认领重审。
- [x] 两笔真实卡死订单退款落账：`46e11fa3` ¥72.00 / `255a1060` ¥1.37。

## 四、界面体验

- [x] 用户订单页提供退款申请入口、金额/原因、退款到钱包说明、申请进度和拒绝/失败原因；显示实际可退余额。
- [x] 用户实例详情页提供退款面板（本轮新增，见第一节）。
- [x] 管理员提供退款审核列表，批准前展示申请金额；驳回原因可见。
- [~] 管理员列表的「订单/服务/支付摘要」：目前只显示 `orderId`、`userId`、金额、状态、`serviceId` 徽章，没有商品名/主机名/支付方式摘要。
- [ ] 加载/重复提交/冲突/失败/成功反馈统一使用后台通知，窄屏可用并有空态。

## 五、验收

- [x] 覆盖并发重复申请/批准、重复 HTTP 重试、超额、部分后补退、退款期间履约竞争、开通未知、活动实例、钱包提交失败、通知失败（单测 + store 220→257 passed）。
- [x] 前后端构建、相关类型检查及商店全量测试通过（store 后端 257 passed/25 files、前端 40 passed/4 files、`tsc` 全绿）。
- [x] 实页验收申请/审核界面：真实申请 + 真实驳回两次（含真实关机/开机），未触发真实退款。
- [ ] **真实退款未触发过**（见第二节第 1 条）。
- [x] 外部支付渠道原路退款接口没有现成通用合约；本期不实现、不承诺原路退回。待支付提供方退款契约另行接入。

---

## 六、上游能力现状（本轮取证结论，影响退款上限）

- 上游**无退款 API**（`refund/host/:id/refund`、`refund/pending/amount`、`refund`、`host/refund`、`order/refund` 全 404）。
- 上游**工单只能读、不能建**（`ticket/list` 200、`ticket/department` 200、`POST ticket` 三种参数变体全 404 HTML；`ticket sum` 保持 1，确认没建脏单）。
- 可写的「停用」入口只有 `host/cancel`（申请停用，参数名必须是 `host_id`，重复提交 406「已提交过申请」按幂等成功处理）。

因此「上游把我们付的钱退回来」这一步永远要上游客服人工处理。我们能自动化的终点是：**退客户到钱包 + 向上游提交停用申请**。
