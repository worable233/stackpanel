import { allowedChoices, visibleOptions } from '@stackpanel/sdk';
import type { CheckoutConfigSchema, CheckoutSelection } from '@stackpanel/sdk';

/** Reconcile stale dependent choices after changing a parent or billing cycle. */
export function reconcileSelection(
  schema: CheckoutConfigSchema,
  selection: CheckoutSelection,
): CheckoutSelection {
  const cycle = schema.cycles.some((item) => item.id === selection.cycle)
    ? selection.cycle!
    : (schema.cycles[0]?.id ?? '');
  const selections = { ...selection.selections };
  for (let pass = 0; pass <= schema.options.length; pass++) {
    let changed = false;
    const visible = new Set(
      visibleOptions(schema, { cycle, selections }).map((option) => option.id),
    );
    for (const option of schema.options) {
      if (!visible.has(option.id)) {
        if (option.id in selections) {
          delete selections[option.id];
          changed = true;
        }
        continue;
      }
      const choices = allowedChoices(schema, option.id, { cycle, selections });
      const current = selections[option.id];
      if (option.type === 'select' && !choices.some((choice) => choice.id === current)) {
        const next =
          choices.find((choice) => choice.id === option.defaultChoice)?.id ?? choices[0]?.id;
        if (next !== current) {
          if (next === undefined) delete selections[option.id];
          else selections[option.id] = next;
          changed = true;
        }
      } else if (option.type === 'quantity' && current === undefined) {
        selections[option.id] = option.min ?? choices[0]?.qtyMin ?? 0;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return { ...selection, ...(cycle ? { cycle } : {}), selections };
}
