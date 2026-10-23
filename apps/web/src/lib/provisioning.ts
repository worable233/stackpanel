/**
 * Whether this web process is running the first-boot bootstrap (BOOTSTRAP-R10).
 *
 * In provision mode the API deliberately exposes only health + setup routes:
 * there is no platform info, no active theme, no plugin frontends, and no
 * database. Asking for them produces a burst of 404s on every render, and can
 * trip the shared circuit breaker that the login path also uses.
 *
 * The value is injected by `ecosystem.config.cjs` from the bootstrap state, so
 * the web process knows the phase without calling the API or reading disk.
 * Absent (legacy deployments) means "normal mode": never skip real work by
 * default.
 */
export function isProvisioningMode(): boolean {
  return process.env.STACKPANEL_BOOTSTRAP_STATE === 'provision';
}
