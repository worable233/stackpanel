# Isolated RPC Protocol

The host and plugin worker exchange versioned JSON messages over the Node IPC
channel. Every message contains `protocol: 1` and the authenticated `pluginId`.
Requests carry a random `id`; responses carry the same id. Unknown protocol or
plugin ids are ignored.

## Limits and failure behavior

- 1 MiB encoded message limit per direction.
- 64 in-flight requests per worker.
- 10 second timeout in both directions.
- A timeout in either direction rejects the caller and sends a best-effort
  `cancel` message. The receiver drops the response; underlying database
  drivers must still use their own cancellation/deadline where available.
  Host-originated route, lifecycle, service, and transaction calls use the same
  cancellation path as worker-originated capability calls.
- Worker exit rejects pending calls, removes registrations, and marks the plugin
  failed. The next activation starts a fresh worker. After three worker exits the
  runtime opens a circuit and refuses further activation until the plugin is
  re-registered with a repaired package.

## Wire values

JSON-compatible values are passed as-is. `Date`, `Buffer`, `bigint`, and `Error`
are tagged as `{ "__spType": ..., "value": ... }`. Cyclic objects are rejected.
Errors preserve `message`, optional `name`, `code`, `status`, and `details`.

The protocol is not a transparent JavaScript object transport: class instances,
functions, streams, sockets, and arbitrary prototypes do not cross the boundary.
Raw streaming routes and synchronous event interception/waterfalls are rejected
in isolated mode.
