# Agent 对话持久化

当前范围：悬浮聊天窗口的用户会话与消息存储。保存消息不会启动 Agent、调用模型或执行业务操作。界面不再生成演示总结；真实运行的步骤、总结和审批接线独立于消息保存。

## 数据与权限

- `AgentConversation` 关联登录用户；删除用户时级联删除会话。
- `AgentChatMessage` 保存用户原文、思考强度及服务端时间。
- `AgentMessageAttachment` 关联平台私有附件；二进制复用现有对象存储，不把 Base64 写入数据库。只接受本人拥有的 PNG/JPEG/GIF/WebP，最多 4 张、每张 5 MiB。关联附件由外键保护，不会被直接删掉。
- 接口仅使用当前人的登录会话，不接受 API Key 代替人管理对话。客户端不能指定消息角色、总结、用户 ID 或执行状态。
- GET 不启动执行。消息没有自动发送至模型。

## 接口

所有内核路径位于 `/api/v1/agent/conversations`，Web 通过同源 `/api/agent/conversations` BFF 访问。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/` | 列表；`search` 按名称搜索，`limit/cursor` 分页 |
| POST | `/` | 创建；`{ id: UUID, title }`，重复 ID 返回已创建的本人会话 |
| GET | `/:id` | 最近一页消息；`limit/cursor` 加载更早消息 |
| PUT | `/:id` | `{ title }` 重命名 |
| DELETE | `/:id` | 删除会话及消息；不删除平台附件二进制 |
| PUT | `/:id/messages/:messageId` | 保存 `{ content, reasoning, attachmentIds }`，UUID 为幂等标识 |

会话及消息采用稳定键分页，不限制只能查看最近若干条。消息保存事务锁定会话，校验附件所有权与私有性。同一消息 ID 的相同内容重试不重复写入；不同内容返回 409。超时后保留草稿，由用户显式重试，不自动重复发送。

图片上传通过 `POST /api/agent/attachments?filename=...`，原始二进制正文；BFF 强制私有上传并限制格式和大小。图片读取通过 `GET /api/agent/attachments/:id`，要求登录且属于本人，使用 `private, no-store` 缓存策略。写 BFF 验证同源 Origin。

## 部署与验证

1. `pnpm --filter @stackpanel/db migrate:deploy`
2. `pnpm --filter @stackpanel/db build`
3. 重启 API 与 Web（开发 watch 自动重载）。

新增集成测试 `apps/api/tests/integration/agent-conversations.test.ts` 使用真实 PostgreSQL 与会话认证。执行时先准备独立测试库并应用迁移，再设置 `AGENT_TEST_DATABASE_URL` 为以 `stackpanel_agent_audit_` 开头的数据库 URL：

```sh
pnpm --filter @stackpanel/api exec vitest run --config vitest.agent-chat.config.ts
```

测试不重置数据库；创建的测试用户、会话和附件元数据在测试结束后清理。
