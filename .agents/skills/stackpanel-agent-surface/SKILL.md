---
name: stackpanel-agent-surface
description: Design, implement or review a StackPanel operation exposed to Open Platform API, MCP or the kernel Agent. Use for capabilities, tool schemas, approval policy, idempotency, destructive actions, agent runs or MCP tools.
---

# StackPanel Agent Surface

Read `/Users/worable/Documents/StackPanel-docs/docs/developer-guide/agent/surface.md`, `apps/api/src/lib/capability-registry.ts`, `packages/sdk/src/{plugin,mcp}.ts`, and the owning route before editing.

## Surface checklist

For every operation record:

1. Stable namespaced capability ID, HTTP method and public `/api/v1` path.
2. Original route and its auth/permission guard. A public alias may only narrow access.
3. Structured input and output validation, field constraints and stable problem codes. Current Capability metadata does not yet carry a domain JSON Schema.
4. `mutating`, `destructive`, idempotency and retry behavior.
5. Approval level, human-readable impact summary, audit action/resource/resourceId and secret-redaction rules.
6. Expected behavior through capability discovery, MCP tool listing and Agent execution.

## Rules

- Never add arbitrary shell execution, unrestricted URL fetching, raw database access or a privilege escalation path.
- Split destructive work into preview and execute steps where an impact summary is possible.
- Public mutating capabilities need `Idempotency-Key`; retries reuse the key only for the same intent. The generic idempotency layer does not compare request bodies.
- Return structured data that the Agent can reason about. Do not make the model parse display prose or logs.
- Agent and MCP must re-enter the same business route; no parallel implementation.

## Verification

Test authorization, discovery, MCP write scope, idempotency replay/conflict, approval approve/deny/expiry, audit output and retry behavior. Update the OpenAPI contract snapshot when the public operation changes.
