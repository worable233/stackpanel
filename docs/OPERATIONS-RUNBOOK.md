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
