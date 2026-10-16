/** Small explicit allowlist; this must never become an arbitrary kernel proxy. */
export function agentProxyTarget(method: string, segments: string[]): string | null {
  if (!segments.length || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))) return null;
  const path = segments.join('/');
  const user = /^(status|models|credential|runs(?:\/[A-Za-z0-9_-]+(?:\/(?:resume|cancel))?)?|approvals(?:\/[A-Za-z0-9_-]+\/decide)?|profiles\/[A-Za-z0-9_-]+|mcp-servers(?:\/[A-Za-z0-9_-]+\/credential)?|oauth\/authorize)$/;
  const admin = /^admin\/(model|enabled|runs(?:\/[A-Za-z0-9_-]+)?|profiles\/[A-Za-z0-9_-]+|mcp-servers(?:\/[A-Za-z0-9_-]+(?:\/discover)?)?|oauth-clients(?:\/[A-Za-z0-9_-]+)?|actions(?:\/[A-Za-z0-9_-]+)?)$/;
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) return null;
  return user.test(path) ? `/api/v1/agent/${path}` : admin.test(path) ? `/admin/agent/${path.slice(6)}` : null;
}
