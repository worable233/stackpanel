/**
 * MCP credential resolution (PLAN-open-platform P2).
 *
 * MCP is a transport adapter over the open platform: `/mcp` authenticates with
 * the exact same credential as `/api/v1` (a session cookie or an `ApiToken`),
 * derives its tool list from the same capability registry, and executes each
 * tool by calling the same `/api/v1` handler through the app's own HTTP stack.
 * Nothing here reimplements a domain operation (ADR-0001).
 *
 * Two per-credential gates apply:
 *   - capability scope: the registry already intersected token scopes with the
 *     owner's permissions, so a tool only appears if the credential holds it.
 *   - {@link MCP_WRITE_SCOPE}: mutating tools additionally require an explicit
 *     grant on a token, so an agent cannot silently change state.
 */
import type { FastifyRequest } from 'fastify';
import {
  MCP_WRITE_SCOPE,
  type McpCapability,
  type McpServerInfo,
} from '@stackpanel/sdk';
import { capabilitiesFor } from '../lib/capability-registry.ts';
import { currentUser } from '../plugins/auth.ts';

/**
 * The write scope is identity-rooted, not a registry permission: every user may
 * delegate writes to their own tokens, but a token must opt in. It is therefore
 * granted implicitly to interactive sessions and rejected against the owner's
 * permission set (which never contains it).
 */
export function isKnownPlatformScope(scope: string): boolean {
  return scope === MCP_WRITE_SCOPE;
}

/** The MCP server identity advertised during `initialize`. */
export const MCP_SERVER_INFO: McpServerInfo = {
  name: 'stackpanel',
  version: '0.4.0',
  instructions:
    'StackPanel open platform. Tools map 1:1 to /api/v1 capabilities granted to the presented credential. ' +
    `Mutating tools require a platform token that declares the "${MCP_WRITE_SCOPE}" scope.`,
};

/** Capabilities the presented credential may call, as MCP tools. */
export function mcpCapabilitiesFor(request: FastifyRequest): McpCapability[] {
  const user = currentUser(request);
  return capabilitiesFor(user.permissions, request.server.pluginRuntime.listCapabilities());
}

/**
 * Scopes declared by the presented credential, or `null` for an interactive
 * session (which carries the owner's full authority and may write).
 */
export function mcpGrantedScopes(request: FastifyRequest): ReadonlySet<string> | null {
  const user = currentUser(request);
  if (!user.viaApiToken) return null;
  return new Set(user.tokenScopes ?? []);
}

/**
 * Scope names to advertise through `/me/api-tokens/scopes`, so a user can grant
 * MCP write access when creating a token. It is deliberately not persisted in
 * the permission table: validity is checked against the owner's implicit right
 * to delegate, mirroring how `platform.admin` gates admin actions.
 */
export function mcpGrantableScopes(): { key: string; name: string }[] {
  return [{ key: MCP_WRITE_SCOPE, name: 'MCP 写入授权（允许通过 MCP 执行写操作）' }];
}
