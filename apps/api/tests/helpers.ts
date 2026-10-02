import { probeDatabase } from '@stackpanel/db';
import type { ExtensionClient } from '@stackpanel/sdk';
import { env } from '../src/config/env.ts';
import type { PluginExtensionRuntime } from '../src/extensions/service.ts';

/**
 * Probe DB availability with a short-lived direct connection.
 * PostgreSQL is the only supported engine (ADR-0019).
 */
export async function checkDbAvailable(): Promise<boolean> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await probeDatabase(env.DATABASE_URL)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/**
 * No-op Extension runtime for unit tests that only exercise lifecycle wiring.
 * Any attempt to actually use the returned client throws.
 */
export function stubExtensionRuntime(): PluginExtensionRuntime {
  const client = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('stub extension runtime: data access is not available in this test');
      },
    },
  ) as ExtensionClient;
  return {
    registerModels: async () => undefined,
    unregisterModels: () => undefined,
    applyRetention: async () => undefined,
    client: () => client,
    clientWith: () => client,
  };
}
