# API 兼容性矩阵（llm-gateway 中转）

本文是 llm-gateway 公网 API 的**权威支持矩阵**。矩阵由插件源码
`packages/plugins/llm-gateway/src/endpoints.ts` 的 `ENDPOINTS` 注册表决定；
插件的单元测试 `src/endpoints.test.ts` 断言「本文件与注册表逐条一致」，因此本文件
不会漂移。新增或删除 endpoint 必须同步改注册表与本表。

- 入口前缀：`/llm-gateway/`（下文路径均为前缀之后的相对路径）。
- 鉴权：请求头 `Authorization: Bearer <sp_ 开头的网关 key>`，或查询串 `?key=`。
- 计费：请求开始时按上限**预授权冻结**钱包余额，结束时按真实用量结算并退还差额。
- 错误体：统一 OpenAI 兼容 schema（见下文「错误模型」）。

## 状态含义

| 状态 | HTTP | 含义 |
| --- | --- | --- |
| `supported` | 按上游 | 本期已实现，按 endpoint 语义转发/处理。 |
| `unsupported` | 501 | 路径属于既有生态但本期**明确不做**（不静默回落成 Chat）。 |
| `reserved` | 404 | 保留路径，暂不开放。 |

未命中任何注册表条目的路径返回 **404 `endpoint_not_found`**；同一路径存在但
请求方法不匹配返回 **405 `method_not_allowed`**。二者都不会回落到
`/v1/chat/completions`（这是硬性约束，取代旧实现的未知路径 Chat 回落）。

## 实现矩阵

| endpoint | 方法 | 路径 | 协议族 | 请求体 | 响应 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `chat.completions` | POST | `v1/chat/completions` | OpenAI Chat | json | json / sse | supported | `stream:true` 时 SSE 透传 |
| `responses.create` | POST | `v1/responses` | OpenAI Responses | json | json / sse | supported | |
| `models.list` | GET | `v1/models` | meta | none | json | supported | 仅列出已启用定价的对外模型名 |
| `models.get` | GET | `v1/models/:model` | meta | none | json | supported | 未知模型 404 |
| `anthropic.messages` | POST | `v1/messages` | Anthropic Messages | json | json / sse | supported | |
| `anthropic.count_tokens` | POST | `v1/messages/count_tokens` | Anthropic Messages | json | json | supported | 请求体原样透传 |
| `gemini.generate_content` | POST | `v1beta/models/:model:generateContent` | Google Gemini | json | json | supported | |
| `gemini.stream_generate_content` | POST | `v1beta/models/:model:streamGenerateContent` | Google Gemini | json | sse | supported | 流式由路径 action 决定 |
| `gemini.embed_content` | POST | `v1beta/models/:model:embedContent` | Google Gemini | json | json | supported | operation=embeddings |
| `gemini.batch_embed_contents` | POST | `v1beta/models/:model:batchEmbedContents` | Google Gemini | json | json | supported | operation=embeddings |
| `embeddings.create` | POST | `v1/embeddings` | OpenAI Embeddings | json | json | supported | operation=embeddings |
| `images.generations` | POST | `v1/images/generations` | OpenAI Images | json | json | supported | 按张预留/计费 |
| `images.edits` | POST | `v1/images/edits` | OpenAI Images | multipart | json | supported | bodyLimit 32 MiB |
| `audio.speech` | POST | `v1/audio/speech` | OpenAI Audio | json | binary | supported | 响应二进制流式 |
| `audio.transcriptions` | POST | `v1/audio/transcriptions` | OpenAI Audio | multipart | json | supported | bodyLimit 64 MiB |
| `audio.translations` | POST | `v1/audio/translations` | OpenAI Audio | multipart | json | supported | bodyLimit 64 MiB |
| `moderations.create` | POST | `v1/moderations` | OpenAI Moderations | json | json | supported | |
| `rerank.create` | POST | `v1/rerank` | OpenAI Rerank | json | json | supported | 由支持 rerank 的 provider 承接 |
| `files.list` | GET | `v1/files` | OpenAI Files | none | json | supported | |
| `files.create` | POST | `v1/files` | OpenAI Files | multipart | json | supported | bodyLimit 512 MiB |
| `files.delete` | DELETE | `v1/files/:id` | OpenAI Files | none | json | supported | |
| `batches.create` | POST | `v1/batches` | OpenAI Batches | json | json | supported | |
| `batches.get` | GET | `v1/batches/:id` | OpenAI Batches | none | json | supported | |
| `fine_tuning.create` | POST | `v1/fine_tuning/jobs` | OpenAI Fine-tuning | json | json | supported | |
| `fine_tuning.get` | GET | `v1/fine_tuning/jobs/:id` | OpenAI Fine-tuning | none | json | supported | |
| `realtime.session` | GET | `v1/realtime` | OpenAI Realtime | none | websocket | unsupported | 见「剩余限制：WebSocket」 |
| `responses.websocket` | GET | `v1/responses` | OpenAI Realtime | none | websocket | unsupported | 见「剩余限制：WebSocket」 |
| `assistants.create` | POST | `v1/assistants` | meta | json | json | unsupported | 请改用 Responses |
| `threads.create` | POST | `v1/threads` | meta | json | json | unsupported | 请改用 Responses |
| `vector_stores.create` | POST | `v1/vector_stores` | meta | json | json | unsupported | |
| `uploads.create` | POST | `v1/uploads` | meta | json | json | unsupported | 请用 `/v1/files` 一次上传 |

## 入口协议与上游协议互转

四种入口协议先解码为协议中立 IR，再按目标账号的 provider 编码为上游协议，因此
**任意入口协议可以转发到任意上游 provider**（只要该 provider 支持对应的 operation）：

| 入口协议 | 代表 endpoint |
| --- | --- |
| OpenAI Chat | `/v1/chat/completions` |
| OpenAI Responses | `/v1/responses` |
| Anthropic Messages | `/v1/messages`、`/v1/messages/count_tokens` |
| Google Gemini | `/v1beta/models/{model}:{action}` |

## 上游 provider 与 operation 能力

13 个内置 provider（`src/adaptors/`）。某 provider 不声明某 operation 时，命中该
endpoint 会返回 **502 `upstream_model_unsupported`**，而不是把请求发到不支持的上游。

| provider | 协议 | 典型 operation |
| --- | --- | --- |
| `openai` | OpenAI Chat | 全部 15 项 operation |
| `azure-openai` | OpenAI Chat | 对话 + embeddings + images |
| `anthropic` | Anthropic Messages | 仅对话（工具调用、缓存） |
| `gemini` | Google Gemini | 对话 + embeddings |
| `vertex` | Google Gemini | 对话 + embeddings（需 project/region/accessToken） |
| `bedrock` | Anthropic Messages | 仅对话（SigV4 签名） |
| `deepseek` | OpenAI Chat | 对话（`reasoning_content`、缓存命中） |
| `mistral` | OpenAI Chat | 对话 + embeddings + moderations |
| `cohere` | OpenAI Chat | 对话 + embeddings + rerank |
| `ollama` | OpenAI Chat | 对话 + embeddings（本地，无鉴权） |
| `openrouter` | OpenAI Chat | 对话 + images.generations |
| `siliconflow` | OpenAI Chat | 对话 + embeddings + images + audio + rerank |
| `openai-compatible` | OpenAI Chat | 对话 + embeddings + images + moderations + rerank |

provider 为无法识别的值时**显式失败**（502），不回落成自定义 provider——写错
provider 必须暴露，而不是静默打到错误的上游。

## 响应头与流式

- 上游响应头按白名单透传；`set-cookie` 单列转发；hop-by-hop 头（`connection`、
  `transfer-encoding` 等）与鉴权头（`authorization`、`x-api-key`、`x-goog-api-key`
  等）一律剥离，绝不把上游凭证回灌给客户端。
- SSE：入口协议与上游协议一致时逐块透传；不一致时解码为 IR 再用入口编码器重编码。
- 慢客户端：写出用 `BackpressureWriter`，`write` 返回 false 时 `await drain()`，
  不让内核无界排队。

## 限流与并发

全部准入计数经 `StateService`（生产为 Redis，支持多实例）：

- 每 key / 每用户 / 每模型 / 每 provider 的 **RPM** 固定窗口。
- 每 key 在途并发与全局在途并发；超限返回 **429 `concurrency_limited`**。
- 上游账号健康、熔断（连续失败阈值）与冷却（429/408 才施加上游账号冷却，
  5xx 只在请求内重试）。
- 账号池全部满载返回 **502 `no_upstream`**。

## 错误模型

所有分支统一为：

```json
{
  "error": {
    "message": "人类可读信息（已脱敏）",
    "type": "invalid_request_error | authentication_error | ...",
    "code": "稳定机器码",
    "param": null,
    "status": 400
  }
}
```

`code` 是封闭集合（见 `src/errors.ts` 的 `GatewayErrorCode`）。客户端与运维面板
按 `code` 分支，不解析 `message`（`message` 会本地化）。常见码：`invalid_api_key`、
`model_not_allowed`、`endpoint_not_found`、`unsupported_endpoint`、
`insufficient_balance`、`quota_exceeded`、`rate_limited`、`concurrency_limited`、
`upstream_rate_limited`、`upstream_timeout`、`upstream_credential_missing`、
`no_upstream`、`preauth_failed`。

**脱敏纪律**：错误消息、URL、日志、usage 元数据里绝不出现 API key。上游原始响应
体只进审计且经 `redactSecrets` 清洗。

## 计费与结算

- 预授权：请求开始时按「prompt 估算 + max_tokens 顶格 + 非 token 单位（图片张数 /
  音频秒数）」经 `computeAmount` 冻结金额；余额不足返回 **402 `insufficient_balance`**。
- 结算：按上游真实 usage（缺失时估算并标 `estimated`）结算，差额退回；缓存读/写、
  推理 token、图片/音频分别按各自单价计。
- 幂等：一次请求一个稳定 `referenceId`，钱包以 `(referenceType, referenceId)` 幂等；
  结算失败进补偿队列（`llm-gateway.compensation` job）重试，绝不静默吞。补偿超限
  才进入明确欠费态。

## 兼容性说明

- OpenAI SDK：直接改 `baseURL` 到 `https://<host>/llm-gateway/v1` 即可用于 Chat /
  Responses / embeddings / images / audio / files / batches / fine-tuning。
- Anthropic SDK：`baseURL` 指向 `https://<host>/llm-gateway`，使用 `/v1/messages`。
- Gemini SDK：走 `v1beta/models/{model}:{action}` 路径族。
- 未知/未实现路径**不会**被当作 Chat 转发，因此 SDK 打错版本或路径会得到明确的
  404/501，而不是一个来自上游的、语焉不详的 200/404。

## 剩余限制：WebSocket

`GET /v1/realtime` 与 Responses WebSocket **本期不做**，显式返回 **501
`unsupported_endpoint`**。原因：内核插件的路由类型只有 `handler` 与 `raw`，
`raw` 拿到的是已解析完的普通请求，插件无法获得 HTTP 握手（upgrade）时刻，也
没有双向帧通道。真正支持需要内核侧新增 upgrade 通道，属跨内核改动。

实时类需求请改用 `/v1/responses` 或 `/v1/chat/completions` 的 SSE 流式。
