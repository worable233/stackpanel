import 'server-only';

import type { FrontendActionExecutors, PluginActionDefinition } from '@stackpanel/sdk';
import { executePluginAction } from './frontend-plugin-action-executor';

/** Bind a page's declared plugin actions to server actions owned by the BFF. */
export function bindPluginActions(
  pluginId: string,
  actions: PluginActionDefinition[],
  returnPath: string,
): FrontendActionExecutors {
  return Object.fromEntries(
    actions.map((action) => [
      action.id,
      executePluginAction.bind(null, pluginId, action.id, returnPath),
    ]),
  );
}
