# Operations Runbook

## Isolated workers

Check plugin state and API logs for `Plugin worker exited; plugin quarantined`.
The plugin remains unavailable until it is reactivated. Inspect the package
signature, entrypoint, Node version, and the worker's memory limit before retrying.
Repeated crashes indicate a bad package or resource exhaustion; do not loop
manual restarts without correcting the cause.

RPC timeout spikes usually indicate a blocked database/Redis dependency or an
oversized payload. Check `rpc.timeout`, pending request counts, Redis latency,
and the plugin's own logs. The protocol limit is 1 MiB and the default worker
heap cap is 256 MiB (`STACKPANEL_PLUGIN_MAX_OLD_SPACE_MB`).

Each worker also samples its peak resident set and exits (`137`) once it exceeds
`STACKPANEL_PLUGIN_MAX_RSS_MB` (default 512 MiB), which catches off-heap growth
that `--max-old-space-size` does not. Keep this ceiling below the container
`mem_limit` (`API_MEM_LIMIT`, default 768m). An exit with code 137 in the logs is
this guard (or the container OOM killer), not a normal crash.

## Jobs and media

Inspect BullMQ failed jobs and retry only after confirming the handler is active.
An inactive plugin owns no handlers or schedules. Media deletion returning 409
means the reference index still contains an owned or external reference; inspect
`GET /media/:id/references` before removing the resource reference.

## 请求路径容量基线（llm-gateway 中转）

`scripts/bench-gateway.mjs` 是同机可复现的请求路径基线（自带 mock 上游、自建自销毁
bootstrap、独立 `stackpanel_bench` 库），对应 `docs/architecture/PLAN-perf-hardening.md` P0
与 ADR-0022。**用它在改动前后对照，而不是凭感觉判断是否变快。**

```bash
node scripts/bench-gateway.mjs                       # isolated（生产形态）
BENCH_TRUSTED=1 node scripts/bench-gateway.mjs       # trusted 对照
BENCH_LOG_LEVEL=info BENCH_VERBOSE=1 node scripts/bench-gateway.mjs   # 诊断
```

判定口径（见 ADR-0022 D7）：**看「附加延迟」而不是总耗时** —— 总耗时被 LLM 上游的
固有耗时淹没。同机（N=200、并发 16、错误率 0/400）基线：

| 指标 | isolated（生产形态） | trusted（开发形态，对照） |
| --- | --- | --- |
| 附加延迟（非流式）p50 / p95 | 0 ms / 84 ms | 0 ms / 10 ms |
| 首 token（流式）p50 / p95 | 109 ms / 215 ms | 173 ms / 951 ms |
| 并发流 峰值 / 完成 / 超限 | 16 / 200 / 0 | 16 / 200 / 0 |
| PG 池 等待 / max | 0 ms / 10 | 0 ms / 10 |
| RSS 峰值 / 末态 | 293 MB / 242 MB | 289 MB / 146 MB |

isolated 下附加延迟 p95 约为 trusted 的 8 倍，这是跨进程 IPC 加每请求多次
DB/Redis 往返的真实成本。**改动后的验收线：附加延迟 p95 不得高于本表基线**；
P1（背压）之后应额外确认慢客户端不再造成无界排队。

容量上限口径：`RPC_MAX_IN_FLIGHT=64` 与 `RPC_MAX_RAW_STREAMS=256` 是**在途上限**，
不得直接换算成 QPS。压测若出现 `Plugin worker exited; plugin quarantined`，见上一节。

### 容量曲线（实测吞吐）

基线的 p95 告诉你「单请求附加了多少开销」，容量曲线告诉你「这台机器能同时扛多少」。
用 `--sweep` 扫并发档位，每个档位跑一遍非流式负载：

```bash
node scripts/bench-gateway.mjs --sweep=1,4,8,16,32,64 --requests=80 --concurrency=16
BENCH_TRUSTED=1 node scripts/bench-gateway.mjs --sweep=1,4,8,16   # 对照
node scripts/bench-gateway.mjs --slow-read-ms=50                  # 慢客户端背压
node scripts/bench-gateway.mjs --saturate=2 --sweep=1,2,4,8       # 账号满载分支
```

同机实测（isolated，mock 上游，单副本；数值随机器变化，请以同机重复运行为准）：

| 并发 | QPS | 附加延迟 p95 | 总耗时 p95 | RSS |
| --- | --- | --- | --- | --- |
| 1 | ~47 | 0 ms | 31 ms | 341 MB |
| 4 | ~113 | 20 ms | 40 ms | 341 MB |
| 8 | ~108 | 33 ms | 97 ms | 344 MB |
| 16 | ~51 | 197 ms | 418 ms | 349 MB |
| 32 | ~73 | 212 ms | 612 ms | 349 MB |

**读法：吞吐在并发 4–8 附近触顶（约 110 QPS），再往上只增加延迟、不增加吞吐** ——
mock 上游把每请求压到几十毫秒，这时限制来自本机的单核 CPU 与 IPC 往返，而不是
上游。真实 LLM 上游是 1–60 秒量级，同一档位的 QPS 会低得多，但**形状不变**：先
线性增长，然后在单进程 CPU 饱和处拐平。因此「能撑多少」必须实测，不能从
`RPC_MAX_IN_FLIGHT=64` 换算。

`--slow-read-ms` 用来确认 P1 的背压语义：客户端故意拖延读取时，内核应当让生产端
`await drain()` 停下来，而不是把数据堆在内存里（`RAW_MAX_QUEUE_BYTES=4 MiB` 是硬顶，
超出即报错终止该流）。同机实测（isolated，`--slow-read-ms=30`，N=24、并发 8）：
**24/24 全部完成、0 错误、RSS 峰值 328 MB / 末态 159 MB** —— 内存回到低水位，说明慢
客户端造成的是背压而不是无界排队。

`--saturate=N` 把上游账号的 `maxConcurrency` 压到 N，用来确认**超限被明确拒绝而不是
排队**：账号池满载时 `pickAccount` 返回 null → 502 `no_upstream`，每 key 在途超限则
429 `concurrency_limited`。该模式**不套用吞吐/延迟预算线**（排队与拒绝本来就会拉长
p95），只读「拒绝」列是否有值。同机实测（`--saturate=2`）：并发 4/8 档分别出现
12/26 次拒绝、0 个非预期错误。

## Production release gates

Use immutable image digests, verify the cosign signature, and retain the OCI SBOM
and provenance attestations. Run dependency/license audit, Prisma migrations,
typecheck, lint, contract snapshot, unit/integration tests, and the image smoke
check before rollout. Compose production services apply `no-new-privileges`, drop
Linux capabilities, PID/memory/CPU limits, and a noexec temporary filesystem.

The production dependency gate currently uses the official npm advisory database:
`pnpm audit --prod --registry=https://registry.npmjs.org --audit-level high` and
currently returns no production advisories. A full workspace audit still reports
`braces@3.0.3` in the development-only PM2/ESLint glob chain. npm has not
published the advisory's stated fixed `3.0.4` release yet; recheck this exception
on every dependency update and do not treat it as a production runtime waiver.

When a plugin is deactivated, queued and delayed jobs owned by that plugin are
removed from the local memory backend and BullMQ queue. An active job may finish
while deactivation drains HTTP requests; inspect the dead-letter set if a job
continues after the drain window.
