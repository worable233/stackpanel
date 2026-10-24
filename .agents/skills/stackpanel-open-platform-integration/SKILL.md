---
name: stackpanel-open-platform-integration
description: Build or review an integration with StackPanel Open Platform API v1, MCP or Partner API v1. Use for API tokens, scopes, capability discovery, MCP clients, SP v1 Ed25519 signing, webhooks, idempotency or retries.
---

# StackPanel Open Platform Integration

Choose the interface before writing code:

| Need | Interface |
| --- | --- |
| A user or automation calls platform capabilities | `/api/v1` with an API Token |
| An MCP client needs those capabilities as tools | `/mcp` or `@stackpanel/mcp` |
| A channel partner manages catalog, orders or services | `/sp/v1` Partner API |

Read `/Users/worable/Documents/StackPanel-docs/docs/developer-guide/{api,mcp,partner}/` and use runtime discovery instead of copied endpoint tables.

## Open Platform API

- Create a unique minimal-scope `sp_` token for each integration.
- Call `/api/v1/capabilities`; only invoke returned capabilities.
- Send a new `Idempotency-Key` per write intent and reuse it only to retry that intent.
- Treat RFC 9457 `code` as the stable error contract. Handle authentication, authorization, conflict and rate limiting explicitly.

## MCP

- Use `POST /mcp` for Streamable HTTP or `@stackpanel/mcp` for stdio.
- Mutating tools require `mcp.write` in addition to the capability's own scope.
- Refresh the tool list when credentials, permissions or enabled plugins change.

## Partner API

- Sign exact canonical request bytes with Ed25519.
- Generate unique nonce and timestamp per request; never retry with a reused nonce unless the protocol explicitly permits it.
- Verify webhook signatures, deduplicate event IDs and reconcile final state through Partner API reads.
