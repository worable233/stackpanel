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

## Jobs and media

Inspect BullMQ failed jobs and retry only after confirming the handler is active.
An inactive plugin owns no handlers or schedules. Media deletion returning 409
means the reference index still contains an owned or external reference; inspect
`GET /media/:id/references` before removing the resource reference.

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
