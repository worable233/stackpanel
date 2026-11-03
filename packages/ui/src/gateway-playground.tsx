'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  MessageSquare,
  MessageSquarePlus,
  MessagesSquare,
  Settings2,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { cn } from './cn.js';
import { Button } from './button.js';
import { Input } from './input.js';
import { Label } from './label.js';
import { Select } from './select.js';
import { Slider } from './slider.js';
import { Textarea } from './textarea.js';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './sheet.js';

export interface GatewayPlaygroundModel {
  id: string;
  label: string;
}

export interface GatewayPlaygroundLabels {
  title: string;
  subtitle: string;
  newChat: string;
  conversations: string;
  emptyTitle: string;
  emptyHint: string;
  placeholder: string;
  send: string;
  sending: string;
  stop: string;
  you: string;
  assistant: string;
  settings: string;
  settingsDescription: string;
  model: string;
  temperature: string;
  maxTokens: string;
  systemPrompt: string;
  systemPromptPlaceholder: string;
  resetSettings: string;
  close: string;
  requestFailed: string;
  thinking: string;
  deleteChat: string;
  noModels: string;
  latency: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  failed?: boolean;
  latencyMs?: number;
}

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function newConversation(labels: GatewayPlaygroundLabels): Conversation {
  return { id: newId(), title: labels.newChat, messages: [] };
}

/** ChatGPT 风格模型体验：会话列表 + 消息流 + 右侧参数抽屉。 */
export function GatewayPlayground({
  endpoint,
  models,
  labels,
}: {
  endpoint: string;
  models: GatewayPlaygroundModel[];
  labels: GatewayPlaygroundLabels;
}) {
  const [conversations, setConversations] = useState<Conversation[]>(() => [
    newConversation(labels),
  ]);
  const [activeId, setActiveId] = useState(() => conversations[0]?.id ?? '');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [model, setModel] = useState(models[0]?.id ?? '');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2048);
  const [systemPrompt, setSystemPrompt] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = useMemo(
    () => conversations.find((conversation) => conversation.id === activeId) ?? conversations[0],
    [activeId, conversations],
  );
  const messages = active?.messages ?? [];

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, sending]);

  useEffect(() => {
    if (!model && models[0]) setModel(models[0].id);
  }, [model, models]);

  function patchConversation(id: string, update: (current: Conversation) => Conversation): void {
    setConversations((current) =>
      current.map((conversation) => (conversation.id === id ? update(conversation) : conversation)),
    );
  }

  function createChat(): void {
    const conversation = newConversation(labels);
    setConversations((current) => [...current, conversation]);
    setActiveId(conversation.id);
    setInput('');
  }

  function deleteChat(id: string): void {
    setConversations((current) => {
      const next = current.filter((conversation) => conversation.id !== id);
      if (next.length === 0) {
        const replacement = newConversation(labels);
        setActiveId(replacement.id);
        return [replacement];
      }
      if (id === activeId) setActiveId(next[0]?.id ?? '');
      return next;
    });
  }

  function stop(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || sending || !active || !model) return;
    const conversationId = active.id;
    const userMessage: ChatMessage = { id: newId(), role: 'user', content: text };
    patchConversation(conversationId, (conversation) => ({
      ...conversation,
      title: conversation.messages.length === 0 ? text.slice(0, 40) : conversation.title,
      messages: [...conversation.messages, userMessage],
    }));
    setInput('');
    setSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const payloadMessages = [
        ...(systemPrompt.trim() ? [{ role: 'system' as const, content: systemPrompt.trim() }] : []),
        ...active.messages.map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content,
        })),
        { role: 'user' as const, content: text },
      ];
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: payloadMessages,
          temperature,
          maxTokens,
        }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as {
        result?: { text?: string; latencyMs?: number };
        error?: unknown;
      } | null;
      if (!response.ok || !body?.result) throw new Error(labels.requestFailed);
      patchConversation(conversationId, (conversation) => ({
        ...conversation,
        messages: [
          ...conversation.messages,
          {
            id: newId(),
            role: 'assistant',
            content: body.result?.text?.trim() || labels.thinking,
            ...(body.result?.latencyMs ? { latencyMs: body.result.latencyMs } : {}),
          },
        ],
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      patchConversation(conversationId, (conversation) => ({
        ...conversation,
        messages: [
          ...conversation.messages,
          {
            id: newId(),
            role: 'assistant',
            content: error instanceof Error ? error.message : labels.requestFailed,
            failed: true,
          },
        ],
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
    }
  }

  function resetSettings(): void {
    setTemperature(0.7);
    setMaxTokens(2048);
    setSystemPrompt('');
  }

  return (
    <div className="flex min-h-[560px] flex-col gap-4 lg:h-[calc(100dvh-11rem)] lg:max-h-[900px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{labels.subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="lg:hidden"
            aria-label={labels.newChat}
            onClick={createChat}
          >
            <MessageSquarePlus className="size-4" />
            <span className="hidden sm:inline">{labels.newChat}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={labels.settings}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 overflow-hidden rounded-3xl bg-muted/35 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden min-h-0 flex-col gap-3 p-3 lg:flex">
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start bg-background"
            onClick={createChat}
          >
            <MessageSquarePlus className="size-4" />
            {labels.newChat}
          </Button>
          <p className="px-1 pt-1 text-xs font-medium text-muted-foreground">
            {labels.conversations}
          </p>
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {conversations.map((conversation) => {
              const selected = conversation.id === active?.id;
              return (
                <div
                  key={conversation.id}
                  className={cn(
                    'group flex items-center gap-1 rounded-xl px-2 transition-colors',
                    selected ? 'bg-background' : 'hover:bg-background/60',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(conversation.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm"
                  >
                    <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{conversation.title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={labels.deleteChat}
                    onClick={() => deleteChat(conversation.id)}
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col bg-background lg:rounded-3xl">
          <header className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                <Sparkles className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{active?.title ?? labels.newChat}</p>
                <p className="truncate text-xs text-muted-foreground">{model || labels.noModels}</p>
              </div>
            </div>
          </header>

          <div
            ref={scrollRef}
            className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-5 sm:px-6"
          >
            {messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
                <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-foreground">
                  <MessagesSquare className="size-6" />
                </span>
                <p className="mt-4 text-base font-medium">{labels.emptyTitle}</p>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">{labels.emptyHint}</p>
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    'flex flex-col gap-1.5',
                    message.role === 'user' ? 'items-end' : 'items-start',
                  )}
                >
                  <span className="px-1 text-xs text-muted-foreground">
                    {message.role === 'user' ? labels.you : labels.assistant}
                  </span>
                  <div
                    className={cn(
                      'max-w-[min(46rem,92%)] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap',
                      message.role === 'user'
                        ? 'bg-foreground text-background'
                        : message.failed
                          ? 'bg-destructive/10 text-destructive'
                          : 'bg-muted/60 text-foreground',
                    )}
                  >
                    {message.content}
                  </div>
                  {message.latencyMs ? (
                    <span className="px-1 text-[11px] text-muted-foreground tabular-nums">
                      {labels.latency.replace('{ms}', String(message.latencyMs))}
                    </span>
                  ) : null}
                </div>
              ))
            )}
            {sending ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="flex size-8 items-center justify-center rounded-xl bg-muted">
                  <Sparkles className="size-4 animate-pulse" />
                </span>
                {labels.sending}
              </div>
            ) : null}
          </div>

          <div className="border-t border-border/60 p-3 sm:p-4">
            <div className="flex items-end gap-2 rounded-2xl bg-muted/45 p-2">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                placeholder={labels.placeholder}
                aria-label={labels.placeholder}
                className="min-h-[52px] border-0 bg-transparent focus-visible:ring-0"
              />
              {sending ? (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label={labels.stop}
                  onClick={stop}
                >
                  <Square className="size-4" />
                </Button>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  aria-label={labels.send}
                  disabled={!input.trim() || !model}
                  onClick={() => void send()}
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent side="right" closeLabel={labels.close} className="sm:max-w-sm">
          <SheetHeader>
            <SheetTitle>{labels.settings}</SheetTitle>
            <SheetDescription>{labels.settingsDescription}</SheetDescription>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="playground-model">{labels.model}</Label>
              <Select
                id="playground-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.length === 0 ? <option value="">{labels.noModels}</option> : null}
                {models.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>{labels.temperature}</Label>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {temperature.toFixed(1)}
                </span>
              </div>
              <Slider
                value={[temperature]}
                onValueChange={(value) =>
                  setTemperature(Array.isArray(value) ? (value[0] ?? 0) : value)
                }
                min={0}
                max={2}
                step={0.1}
                aria-label={labels.temperature}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="playground-max-tokens">{labels.maxTokens}</Label>
              <Input
                id="playground-max-tokens"
                type="number"
                min={1}
                max={32000}
                value={maxTokens}
                onChange={(event) => setMaxTokens(Number(event.target.value) || 1)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="playground-system">{labels.systemPrompt}</Label>
              <Textarea
                id="playground-system"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
                placeholder={labels.systemPromptPlaceholder}
                rows={5}
              />
            </div>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={resetSettings}>
              {labels.resetSettings}
            </Button>
            <Button type="button" onClick={() => setSettingsOpen(false)}>
              {labels.close}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
