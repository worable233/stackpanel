import type {
  AuthService,
  EventBus,
  ExtensionClient,
  PluginContext,
  PluginSecrets,
  StateService,
} from '@stackpanel/sdk';
import { ChannelError } from './errors';

let ext: ExtensionClient | null = null;
let auth: AuthService | null = null;
let state: StateService | null = null;
let secrets: PluginSecrets | null = null;
let events: EventBus | null = null;
let ctx: PluginContext | null = null;

/** Bind plugin-scoped dependencies during activation. */
export function bindContext(pluginCtx: PluginContext): void {
  ext = pluginCtx.extensions;
  auth = pluginCtx.auth;
  state = pluginCtx.state;
  secrets = pluginCtx.secrets;
  events = pluginCtx.events;
  ctx = pluginCtx;
}

/** Clear module state during deactivation. */
export function resetContext(): void {
  ext = null;
  auth = null;
  state = null;
  secrets = null;
  events = null;
  ctx = null;
}

/** Resolve the active plugin context (throws 503 until activated). */
export function context(): PluginContext {
  if (!ctx) throw new ChannelError(503, '渠道插件未就绪');
  return ctx;
}

export function extensions(): ExtensionClient {
  if (!ext) throw new ChannelError(503, '渠道插件未就绪');
  return ext;
}

export function authService(): AuthService {
  if (!auth) throw new ChannelError(503, '渠道插件未就绪');
  return auth;
}

export function stateService(): StateService {
  if (!state) throw new ChannelError(503, '渠道插件未就绪');
  return state;
}

export function secretStore(): PluginSecrets {
  if (!secrets) throw new ChannelError(503, '渠道插件未就绪');
  return secrets;
}

export function bus(): EventBus {
  if (!events) throw new ChannelError(503, '渠道插件未就绪');
  return events;
}

/** Resolve the plugin's logger (no-op outside activation so late tasks don't throw). */
export function logger(): PluginContext['logger'] {
  return ctx?.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
}
