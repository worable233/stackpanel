'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import dynamic from 'next/dynamic';
import { json, jsonLanguage, jsonParseLinter } from '@codemirror/lang-json';
import type { CompletionContext } from '@codemirror/autocomplete';
import { linter } from '@codemirror/lint';
import {
  buildZodFromSettingsSchema,
  migrateFrontendSettings,
  type FrontendSettings,
  type FrontendSettingsField,
  type FrontendSettingsSchema,
} from '@stackpanel/sdk';
import { useRouter } from 'next/navigation';
import { Braces, Check, Download, Eye, History, RotateCcw, Save, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { useTranslator } from '@/i18n/provider';
import {
  previewThemeSettingsAction,
  saveThemeConfigurationAction,
} from '@/lib/frontend-settings-actions';
import type { ThemeConfiguration } from '@/lib/theme-configuration';

const CodeMirror = dynamic(() => import('@uiw/react-codemirror').then((mod) => mod.default), {
  ssr: false,
});
const print = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * Validate a JSON draft against the theme's settings schema.
 *
 * Extracted from the component body: React Compiler refuses to preserve a
 * `useMemo` whose callback mixes `try/catch` with early returns, and fails with
 * `react-hooks/preserve-manual-memoization`. A module-level pure function keeps
 * the hook trivial and makes the validation independently testable, which the
 * inline version was not.
 */
function validateDraft(
  schema: FrontendSettingsSchema,
  text: string,
  t: (key: string) => string,
): { settings?: FrontendSettings; error?: string } {
  try {
    const value: unknown = JSON.parse(text);
    const parsed = buildZodFromSettingsSchema(schema).safeParse(value);
    if (!parsed.success)
      return {
        error: parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
          .join('\n'),
      };
    const raw = migrateFrontendSettings(schema, value as FrontendSettings);
    if (raw) {
      for (const [group, fields] of Object.entries(raw)) {
        const definition = schema.groups.find((item) => item.id === group);
        if (!definition) return { error: `${group}: ${t('themeJson.unknownField')}` };
        for (const name of Object.keys(fields))
          if (!definition.fields.some((field) => field.name === name))
            return { error: `${group}.${name}: ${t('themeJson.unknownField')}` };
      }
    }
    return { settings: parsed.data };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : t('themeJson.invalid') };
  }
}

function describeFields(
  fields: FrontendSettingsField[],
  prefix: string,
): Array<{ path: string; field: FrontendSettingsField }> {
  return fields.flatMap((field) => {
    const path = `${prefix}.${field.name}`;
    return [
      { path, field },
      ...(field.type === 'list' ? describeFields(field.fields, `${path}[]`) : []),
    ];
  });
}

export function ThemeJsonEditor({
  themeId,
  schema,
  configuration,
}: {
  themeId: string;
  schema: FrontendSettingsSchema;
  configuration: ThemeConfiguration;
}) {
  const t = useTranslator();
  const router = useRouter();
  const [text, setText] = useState(() => print(configuration.settings));
  const [saved, setSaved] = useState(configuration.settings);
  const [version, setVersion] = useState(configuration.version);
  const [error, setError] = useState<string>();
  const [confirmSave, setConfirmSave] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const read = () => setDark(document.documentElement.classList.contains('dark'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const validation = useMemo(() => validateDraft(schema, text, t), [schema, t, text]);
  const changes = useMemo(() => {
    if (!validation.settings) return [];
    return schema.groups.flatMap((group) =>
      group.fields.flatMap((field) => {
        const before = saved[group.id]?.[field.name];
        const after = validation.settings![group.id]?.[field.name];
        return JSON.stringify(before) === JSON.stringify(after)
          ? []
          : [{ path: `${group.id}.${field.name}`, before, after }];
      }),
    );
  }, [saved, schema, validation.settings]);
  const dirty = validation.settings ? changes.length > 0 : text !== print(saved);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Re-render only valid drafts. Drafts are scoped to this admin and expire.
  useEffect(() => {
    if (!preview || !validation.settings) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setPreviewPending(true);
      const result = await previewThemeSettingsAction(themeId, validation.settings!);
      if (cancelled) return;
      setPreviewPending(false);
      setPreviewError(result.error);
      if (result.ok)
        setPreview(`/preview?theme=${encodeURIComponent(themeId)}&draft=1&v=${Date.now()}`);
    }, 900);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // A new preview URL must not itself trigger another save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validation.settings, themeId, Boolean(preview)]);

  function exportJson() {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${themeId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  async function openPreview() {
    if (!validation.settings) return;
    setPreviewPending(true);
    const result = await previewThemeSettingsAction(themeId, validation.settings);
    setPreviewPending(false);
    setPreviewError(result.error);
    if (result.ok)
      setPreview(`/preview?theme=${encodeURIComponent(themeId)}&draft=1&v=${Date.now()}`);
  }
  function publish() {
    if (!validation.settings) return;
    const next = validation.settings;
    startTransition(async () => {
      const result = await saveThemeConfigurationAction(themeId, next, version);
      if (result.error) {
        setError(result.error);
        return;
      }
      setVersion(result.version!);
      setSaved(next);
      setText(print(next));
      setError(undefined);
      setConfirmSave(false);
      router.refresh();
    });
  }
  const extensions = useMemo(
    () => [
      json(),
      linter(jsonParseLinter()),
      jsonLanguage.data.of({
        autocomplete: (context: CompletionContext) => {
          const word = context.matchBefore(/"?[\w-]*/);
          if (!word || (!context.explicit && word.from === word.to)) return null;
          const options = schema.groups.flatMap((group) => [
            {
              label: group.id,
              type: 'property',
              detail: group.label,
              apply: JSON.stringify(group.id),
            },
            ...describeFields(group.fields, group.id).flatMap(({ path, field }) => [
              {
                label: field.name,
                type: 'property',
                detail: `${path} · ${field.label ?? field.name}`,
                apply: JSON.stringify(field.name),
              },
              ...(field.type === 'select' || field.type === 'radio'
                ? field.options.map((option) => ({
                    label: option.value,
                    type: 'enum',
                    detail: `${path} · ${option.label ?? option.value}`,
                    apply: JSON.stringify(option.value),
                  }))
                : []),
            ]),
          ]);
          return { from: word.from, options };
        },
      }),
    ],
    [schema],
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (validation.settings) setText(print(validation.settings));
          }}
          disabled={!validation.settings || pending}
        >
          <Braces data-icon="inline-start" />
          {t('themeJson.format')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setText(print(configuration.defaults))}
          disabled={pending}
        >
          <RotateCcw data-icon="inline-start" />
          {t('themeJson.defaults')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setText(print(saved))}
          disabled={!dirty || pending}
        >
          {t('themeJson.undo')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={pending}
        >
          <Upload data-icon="inline-start" />
          {t('themeJson.import')}
        </Button>
        <Button variant="ghost" size="sm" onClick={exportJson}>
          <Download data-icon="inline-start" />
          {t('themeJson.export')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label={t('themeJson.import')}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (file) {
              if (file.size > 512 * 1024) setError(t('themeJson.fileTooLarge'));
              else setText(await file.text());
            }
            event.target.value = '';
          }}
        />
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (preview) setPreview(undefined);
              else void openPreview();
            }}
            disabled={!validation.settings || previewPending}
          >
            <Eye data-icon="inline-start" />
            {t(preview ? 'themeJson.closePreview' : 'themeJson.preview')}
          </Button>
          <Button
            size="sm"
            disabled={!dirty || !validation.settings || pending}
            onClick={() => {
              setError(undefined);
              setConfirmSave(true);
            }}
          >
            <Save data-icon="inline-start" />
            {t('themeJson.save')}
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('themeJson.hint')}</p>
      {error || validation.error ? (
        <Alert variant="destructive">
          <AlertDescription className="whitespace-pre-wrap">
            {error ?? validation.error}
          </AlertDescription>
        </Alert>
      ) : (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Check className="size-3.5" />
          {dirty ? t('themeJson.unsaved', { count: changes.length }) : t('themeJson.saved')}
        </p>
      )}
      <div className={preview ? 'grid min-w-0 gap-4 xl:grid-cols-2' : 'min-w-0'}>
        <div className="min-w-0 overflow-hidden rounded-lg border">
          <CodeMirror
            value={text}
            onChange={(value) => {
              setText(value);
              setError(undefined);
            }}
            height="min(65vh, 760px)"
            theme={dark ? 'dark' : 'light'}
            extensions={extensions}
            editable={!pending}
            aria-label={t('themeJson.editor')}
            basicSetup={{ foldGutter: true, highlightActiveLine: true, lineNumbers: true }}
          />
        </div>
        {preview ? (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {t(previewPending ? 'themeJson.previewUpdating' : 'themeJson.previewHint')}
            </p>
            {previewError ? (
              <Alert variant="destructive">
                <AlertDescription>{previewError}</AlertDescription>
              </Alert>
            ) : null}
            <iframe
              src={preview}
              title={t('themeJson.preview')}
              className="h-[65vh] w-full rounded-lg border bg-background"
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        ) : null}
      </div>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">{t('themeJson.fields')}</summary>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          {schema.groups.map((group) => (
            <div key={group.id} className="flex flex-col gap-1">
              <strong>{group.label ?? group.id}</strong>
              {describeFields(group.fields, group.id).map(({ path, field }) => (
                <div key={path} className="flex flex-col gap-1">
                  <span>
                    <code>{path}</code> — {field.label ?? field.name}
                  </span>
                  {field.help ? <p className="text-muted-foreground">{field.help}</p> : null}
                  {field.type === 'select' || field.type === 'radio' ? (
                    <code className="break-words text-muted-foreground">
                      {field.options.map((option) => option.value).join(' · ')}
                    </code>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
      </details>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          <History className="mr-1 inline size-4" />
          {t('themeJson.history')}
        </summary>
        <p className="mt-2 text-xs text-muted-foreground">{t('themeJson.historyHint')}</p>
        <div className="mt-2 flex flex-col gap-1">
          {configuration.history.map((entry, index) => (
            <div
              key={`${entry.version}-${index}`}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span>
                {entry.savedAt.replace('T', ' ').slice(0, 19)} · {entry.version.slice(0, 8)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setText(print(entry.settings))}
              >
                {t('themeJson.loadVersion')}
              </Button>
            </div>
          ))}
        </div>
      </details>
      <Dialog
        open={confirmSave}
        onOpenChange={(open) => {
          if (!pending) setConfirmSave(open);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('themeJson.review', { count: changes.length })}</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[55vh] flex-col gap-4 overflow-auto">
            {changes.map((change) => (
              <div key={change.path} className="flex flex-col gap-1 text-xs">
                <code className="font-medium">{change.path}</code>
                <div className="grid gap-2 sm:grid-cols-2">
                  <pre className="overflow-auto rounded bg-muted p-2 line-through opacity-60">
                    {print(change.before)}
                  </pre>
                  <pre className="overflow-auto rounded bg-muted p-2">{print(change.after)}</pre>
                </div>
              </div>
            ))}
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSave(false)} disabled={pending}>
              {t('common.cancel')}
            </Button>
            <Button onClick={publish} disabled={pending}>
              {t(pending ? 'themeJson.saving' : 'themeJson.publish')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
