'use client';

import { useEffect, useRef, useState } from 'react';
import { Slider } from './slider.js';
import { Select } from './select.js';
import { Input } from './input.js';
import { RadioGroup } from '@animate-ui/react/primitives/base-ui/radio-group';
import { Radio } from '@base-ui/react/radio';
import {
  SiDebian,
  SiUbuntu,
  SiRockylinux,
  SiCentos,
  SiFedora,
  SiAlmalinux,
  SiOpensuse,
  SiFreebsd,
} from '@icons-pack/react-simple-icons';
import { ChevronDown, Monitor } from 'lucide-react';
import { imageFamily } from './image-family.js';

const systemIcons = {
  debian: SiDebian,
  ubuntu: SiUbuntu,
  rocky: SiRockylinux,
  centos: SiCentos,
  fedora: SiFedora,
  almalinux: SiAlmalinux,
  opensuse: SiOpensuse,
  freebsd: SiFreebsd,
};
const systemNames: Record<string, string> = {
  debian: 'Debian',
  ubuntu: 'Ubuntu',
  rocky: 'Rocky Linux',
  centos: 'CentOS',
  fedora: 'Fedora',
  windows: 'Windows',
  almalinux: 'AlmaLinux',
  opensuse: 'openSUSE',
  freebsd: 'FreeBSD',
  rhel: 'Red Hat',
  alpine: 'Alpine Linux',
  oracle: 'Oracle Linux',
  arch: 'Arch Linux',
};

/** Image families are derived only from actual provider choices; versions keep their IDs. */
export function ConfigurationImages({
  name,
  label,
  versionLabel,
  otherLabel,
  choices,
  defaultValue,
}: {
  name: string;
  label: string;
  versionLabel: string;
  otherLabel: string;
  choices: Array<{ id: string; label: string }>;
  defaultValue: string;
}) {
  const [selected, setSelected] = useState(defaultValue);
  const select = useRef<HTMLSelectElement>(null);
  const pendingChange = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (pendingChange.current && select.current) {
      pendingChange.current = false;
      select.current.value = selected;
      select.current.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, [selected]);
  useEffect(() => {
    const restore = () => {
      if (select.current) setSelected(select.current.value);
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);
  const family = (choice: { label: string }) => imageFamily(choice.label);
  const groups = Array.from(new Set(choices.map(family)));
  const current = choices.find((choice) => choice.id === selected);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RadioGroup
        aria-label={label}
        value={current ? family(current) : ''}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4"
        onValueChange={(value) => {
          const next = choices.find((choice) => family(choice) === value);
          if (next && select.current) {
            pendingChange.current = true;
            setSelected(next.id);
          }
        }}
      >
        {groups.map((group) => {
          const Icon = systemIcons[group as keyof typeof systemIcons] ?? Monitor;
          return (
            <Radio.Root
              key={group}
              value={group}
              className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-lg border bg-background p-3 text-sm capitalize outline-none data-checked:border-primary data-checked:bg-primary/5 data-checked:text-primary focus-visible:ring-2 focus-visible:ring-ring"
            >
              {group === 'windows' ? (
                <svg aria-hidden="true" className="size-7" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2 3h9v9H2zm11 0h9v9h-9zM2 14h9v9H2zm11 0h9v9h-9z" />
                </svg>
              ) : (
                <Icon aria-hidden="true" className="size-7" />
              )}
              {systemNames[group] ?? otherLabel}
            </Radio.Root>
          );
        })}
      </RadioGroup>
      <div className="flex flex-col gap-2">
        <label htmlFor={`option-${name.replace(/^cfg_/, '')}`} className="text-sm font-medium">
          {versionLabel}
        </label>
        <div className="relative">
          <Select
            ref={select}
            id={`option-${name.replace(/^cfg_/, '')}`}
            aria-label={versionLabel}
            name={name}
            value={selected}
            className="pr-9"
            onChange={(event) => setSelected(event.target.value)}
          >
            {choices
              .filter((choice) => !hydrated || !current || family(choice) === family(current))
              .map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
          </Select>
          <ChevronDown
            aria-hidden="true"
            className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
        </div>
      </div>
    </div>
  );
}

export function ConfigurationQuantity({
  name,
  label,
  min,
  max,
  step = 1,
  defaultValue,
  unit = '',
}: {
  name: string;
  label: string;
  min: number;
  max?: number | undefined;
  step?: number;
  defaultValue: number;
  unit?: string | undefined;
}) {
  const [value, setValue] = useState(defaultValue);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const restore = () => {
      if (input.current && Number.isFinite(input.current.valueAsNumber)) {
        setValue(input.current.valueAsNumber);
      }
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);
  const fixed = max !== undefined && max <= min;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-3">
        <Input
          ref={input}
          id={`option-${name.replace(/^cfg_/, '')}`}
          aria-label={label}
          name={name}
          type="number"
          min={min}
          max={max}
          step={step}
          defaultValue={defaultValue}
          readOnly={fixed}
          required
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) setValue(next);
          }}
        />
        {unit ? <span className="shrink-0 text-xs text-muted-foreground">{unit}</span> : null}
      </div>
      <Slider
        aria-label={label}
        value={[value]}
        min={min}
        max={Math.max(min + 1, max ?? value + 100)}
        step={step}
        disabled={fixed}
        onValueChange={(next) => {
          const number = Array.isArray(next) ? (next[0] ?? min) : next;
          setValue(number);
          if (input.current) {
            input.current.value = String(number);
            input.current.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }}
      />
    </div>
  );
}

/** Discrete stops submit the provider's choice ID, never an inferred numeric value. */
export function ConfigurationSlider({
  name,
  label,
  choices,
  defaultValue,
}: {
  name: string;
  label: string;
  choices: Array<{ id: string; label: string }>;
  defaultValue: string;
}) {
  const initial = Math.max(
    0,
    choices.findIndex((choice) => choice.id === defaultValue),
  );
  const [index, setIndex] = useState(initial);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const input = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    const restore = () => {
      const restored = choices.findIndex((choice) => choice.id === input.current?.value);
      if (restored >= 0) setIndex(restored);
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, [choices]);
  const selected = choices[index];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Select
        ref={input}
        id={`option-${name.replace(/^cfg_/, '')}`}
        name={name}
        defaultValue={defaultValue}
        aria-label={label}
        aria-hidden={hydrated}
        tabIndex={hydrated ? -1 : undefined}
        className={hydrated ? 'sr-only' : undefined}
      >
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </Select>
      <output className="text-sm tabular-nums">{selected?.label}</output>
      <Slider
        aria-label={label}
        value={[index]}
        min={0}
        max={Math.max(1, choices.length - 1)}
        step={1}
        disabled={choices.length <= 1}
        onValueChange={(value) => {
          const next = Array.isArray(value) ? (value[0] ?? 0) : value;
          setIndex(next);
          if (input.current) {
            input.current.value = choices[next]?.id ?? '';
            input.current.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }}
      />
    </div>
  );
}
