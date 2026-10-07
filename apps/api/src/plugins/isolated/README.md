# Isolated plugin execution

In production, third-party packages without an explicit trusted mode are loaded
with `execution: "isolated"`. The API keeps only a manifest and route proxy; the
package entrypoint runs in a dedicated child process with a minimal environment
and a bidirectional IPC timeout/cancellation protocol. An exited child moves the
plugin to `failed`, removes its routes/models/jobs, rejects pending requests,
and is quarantined until the next activation rebuilds it. After three worker
exits, the runtime opens a circuit and requires re-registration with a repaired
package. Development keeps legacy packages without an `execution` field
trusted for compatibility; built-in packages are trusted in every environment.

The isolated protocol exposes JSON HTTP handlers plus explicit RPC capabilities
for lifecycle hooks, media references, declarative and dynamic events, jobs,
state (including callback-based `withLock`), auth, notifications, payments,
wallet, FX, plugin secrets, transactions, custom model CRUD and structured
plugin logging. The synchronous SDK methods `auth.sessionCookieConfig()`,
`secrets.isAvailable()`, and `payments.listPaymentMethods()` receive a snapshot
during lifecycle activation so they retain their synchronous return contract.
Custom model schemas cross the boundary as JSON Schema and are reconstructed in
the host for a second validation pass. Raw streaming handlers and schemas that
cannot be represented as JSON Schema are rejected during worker startup.
Every request has a 10-second timeout, a 1 MiB wire limit and a 64-request
concurrency limit. Dates, buffers, bigint values and errors use tagged wire
encodings; unsupported cyclic values are rejected. Provider registration and extension registration use a method-name and RPC
callback contract. Consumers must declare injected services in the plugin
definition; undeclared synchronous discovery remains unavailable across the
process boundary. `events.intercept()` and `events.waterfall()` remain
explicitly unsupported in isolated mode because their synchronous `next()` and
return-value semantics cannot be preserved over asynchronous IPC.

Built-in packages are trusted because they are shipped with the kernel. A
third party package may request `execution: "trusted"` only outside production;
production validation rejects that mode.
