'use client';

import * as React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Select as SelectPrimitive } from '@animate-ui/react/primitives/base-ui/select';
import { twMerge } from 'tailwind-merge';

interface ParsedOption {
  value: string;
  label: React.ReactNode;
  disabled?: boolean | undefined;
}

/**
 * Animate UI / Base UI Select with a native `<select>` compatible API.
 *
 * The host historically exposed a native select wrapper from `@stackpanel/ui`.
 * Plugin pages pass plain `<option>` children, a `name` for form submission and
 * an optional `onChange`. This wrapper keeps that API while rendering the real
 * Animate UI Base UI primitive, so every existing call site gets the animated
 * popup and check indicator without being rewritten.
 */
export interface SelectProps
  extends Omit<
    React.ComponentPropsWithoutRef<'select'>,
    'children' | 'defaultValue' | 'multiple' | 'onChange' | 'size' | 'value'
  > {
  children?: React.ReactNode;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  className?: string | undefined;
  placeholder?: string | undefined;
  ref?: React.Ref<HTMLSelectElement> | undefined;
}

function collectOptions(children: React.ReactNode): ParsedOption[] {
  const options: ParsedOption[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === 'option') {
      const props = child.props as {
        value?: string | number;
        disabled?: boolean;
        children?: React.ReactNode;
      };
      const label = props.children;
      options.push({
        value: props.value != null ? String(props.value) : String(label ?? ''),
        label,
        disabled: props.disabled,
      });
      return;
    }
    if (child.type === 'optgroup') {
      const props = child.props as { children?: React.ReactNode };
      options.push(...collectOptions(props.children));
    }
  });
  return options;
}

function Select({
  className,
  children,
  value,
  defaultValue,
  onChange,
  placeholder,
  id,
  name,
  form,
  required,
  disabled,
  autoFocus,
  ref,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby,
  'aria-invalid': ariaInvalid,
  'aria-hidden': ariaHidden,
  tabIndex,
  title,
}: SelectProps) {
  const options = collectOptions(children);
  const controlled = value !== undefined;
  const items = Object.fromEntries(options.map((option) => [option.value, option.label]));
  const resolvedDefault =
    defaultValue !== undefined ? String(defaultValue) : (options[0]?.value ?? '');

  function handleValueChange(next: string | null) {
    if (!onChange) return;
    const nextValue = next ?? '';
    onChange({
      target: { value: nextValue, name: name ?? '' },
      currentTarget: { value: nextValue, name: name ?? '' },
    } as React.ChangeEvent<HTMLSelectElement>);
  }

  const inputRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      if (typeof ref === 'function') {
        ref(node as unknown as HTMLSelectElement | null);
      } else if (ref) {
        (ref as React.MutableRefObject<HTMLSelectElement | null>).current =
          node as unknown as HTMLSelectElement | null;
      }
    },
    [ref],
  );

  return (
    <SelectPrimitive.Root
      inputRef={inputRef}
      items={items}
      name={name}
      form={form}
      required={required}
      disabled={disabled}
      value={controlled ? String(value) : undefined}
      defaultValue={controlled ? undefined : resolvedDefault}
      onValueChange={handleValueChange}
      modal={false}
    >
      <SelectPrimitive.Trigger
        id={id}
        data-slot="select"
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-describedby={ariaDescribedby}
        aria-invalid={ariaInvalid}
        aria-hidden={ariaHidden}
        tabIndex={tabIndex}
        title={title}
        className={twMerge(
          'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-left text-sm text-foreground outline-none transition-colors select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:border-ring',
          className,
        )}
      >
        <SelectPrimitive.Value
          data-slot="select-value"
          className="min-w-0 flex-1 truncate"
          placeholder={placeholder ?? (options[0]?.value === '' ? options[0]?.label : undefined)}
        />
        <SelectPrimitive.Icon className="shrink-0 text-muted-foreground transition-transform duration-200 data-[popup-open]:rotate-180">
          <ChevronDown className="size-4" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          side="bottom"
          sideOffset={4}
          align="start"
          alignItemWithTrigger={false}
          className="isolate z-50"
        >
          <SelectPrimitive.Popup
            data-slot="select-content"
            className="max-h-(--available-height) w-(--anchor-width) min-w-36 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
          >
            <SelectPrimitive.List>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="relative flex w-full cursor-default items-center rounded-lg py-2 pr-8 pl-2.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-muted data-highlighted:text-foreground"
                >
                  <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
                    {option.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator
                    render={
                      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
                    }
                  >
                    <Check className="size-4" aria-hidden="true" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { Select };
