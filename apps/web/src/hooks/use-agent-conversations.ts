'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslator } from '@/i18n/provider';
import { agentErrorFromBody, agentErrorText } from '@/lib/agent-errors';

export type ChatAttachment = { id: string; name: string; url: string };
export type ChatTurn = { id: string; objective: string; attachments: ChatAttachment[]; created: number; reasoning: string };
type Conversation = { id: string; title: string; createdAt: string; updatedAt: string };
type Page = { conversations: Conversation[]; nextCursor: string | null };
type Detail = { conversation: Conversation; turns: ChatTurn[]; nextCursor: string | null };

/**
 * 一次 Agent 运行在抽屉里的展示状态（B-1）。
 *
 * 抽屉以前只保存消息、从不执行：`agent_runs` 建站以来 0 行，而界面上那行
 * 「消息已保存 · 尚未启动 Agent 执行」是写死的文案，不是状态。现在提交后**真的
 * 建一条运行**，这里持有它的实时状态给界面渲染。
 */
export type ChatRun = {
  id: string;
  status: string;
  steps: number;
  spendMinor: number;
  model: string | null;
  error: string | null;
  /** 最近一步的可读摘要（工具名或模型输出片段），不是原始 JSON。 */
  latest: string | null;
};

type RunDetail = {
  run: Omit<ChatRun, 'latest'>;
  steps: Array<{ index: number; kind: string; toolName?: string | null; result?: unknown; error?: string | null }>;
};

function runSummary(step: RunDetail['steps'][number] | undefined): string | null {
  if (!step) return null;
  if (step.error) return step.error;
  if (step.toolName) return step.toolName;
  const result = step.result as { parts?: Array<{ type?: string; text?: string }> } | null;
  const text = result?.parts?.find((part) => part?.type === 'text' && typeof part.text === 'string')?.text;
  return text ? text.slice(0, 400) : null;
}

async function chatFetch<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/agent/conversations${path}`, {
    method, headers: { 'content-type': 'application/json' }, cache: 'no-store', signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw agentErrorFromBody(data);
  return data;
}

export function useAgentConversations(open: boolean, search: string) {
  const t = useTranslator();
  const errorText = useCallback(
    (cause: unknown, fallback: string) => agentErrorText(t, cause, fallback),
    [t],
  );
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [run, setRun] = useState<ChatRun | null>(null);
  /**
   * 本回合**发起运行失败**的原因。
   *
   * 与 `error` 分开：`error` 是“对话加载/保存失败”，渲染在抽屉顶部；而“消息
   * 存住了、但 Agent 没跑起来”是**这一回合**的事，必须显示在对应消息下面——
   * 即用户正看着的那一行，否则它就被「消息已保存」盖住了。
   *
   * 事故：管理员已启用 Agent、已选默认模型，但模型提供方解析为 null，内核
   * 返回 503 `agent.llm_unconfigured`。`run` 始终为 null → 界面显示“消息已
   * 保存 · 尚未启动 Agent 执行”，而真正的原因在顶部一条被当作“加载失败”的
   * 红字里，没人会去那里找。
   */
  const [runError, setRunError] = useState('');
  const runGeneration = useRef(0);
  /**
   * 抽屉当前是否打开。
   *
   * `pollRun` 里只看 `runGeneration` 是不够的：那个计数只在**切换回合**时自增，
   * 关闭抽屉不会碰它。于是一条后台运行的轮询会一直跑到 150 次上限（≈5 分钟），
   * 每次一个 `/runs/:id` 请求——用户早就把抽屉关了，网络面板里却还在每 2 秒
   * 响一次，服务端也照样被敲。用 ref 而不是 state：轮询循环要读到**当前值**，
   * 而 state 在闭包里是旧的。
   */
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    // 重新打开时让上一轮还在跑的循环自停，避免两个循环同时写 `run`。
    if (!open) runGeneration.current += 1;
  }, [open]);
  const [refresh, setRefresh] = useState(0);
  const restore = useRef(true);
  const locked = useRef(false);
  const selection = useRef<string | null>(null);
  const pending = useRef<{ conversationId: string; messageId: string; fingerprint: string } | null>(null);
  const listGeneration = useRef(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const generation = ++listGeneration.current;
    const timer = setTimeout(() => {
      setListLoading(true);
      void chatFetch<Page>(`?search=${encodeURIComponent(search)}`, 'GET', undefined, controller.signal).then((page) => {
        if (generation !== listGeneration.current) return;
        setConversations(page.conversations); setNextCursor(page.nextCursor); setError('');
        if (restore.current) {
          restore.current = false;
          selection.current = page.conversations[0]?.id ?? null;
          setActiveId(selection.current);
        }
      }).catch((cause: Error) => { if (!controller.signal.aborted) setError(errorText(cause, t('agent.chat.loadFailed'))); })
        .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    }, search ? 250 : 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, search, refresh, errorText, t]);

  useEffect(() => {
    if (!open || !activeId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setError('');
      void chatFetch<Detail>(`/${activeId}`, 'GET', undefined, controller.signal).then((data) => {
      if (!controller.signal.aborted) setDetail(data);
    }).catch((cause: Error) => { if (!controller.signal.aborted) setError(errorText(cause, t('agent.chat.loadFailed'))); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, activeId, refresh, errorText, t]);

  const select = useCallback((id: string | null) => {
    if (locked.current) return;
    restore.current = false; selection.current = id; pending.current = null;
    setActiveId(id); setDetail(null); setLoading(false); setError('');
    // 切换对话时上一回合的失败原因不属于新对话。
    setRunError('');
  }, []);

  async function submit(content: string, attachments: ChatAttachment[], reasoning: string) {
    if (locked.current) return false;
    locked.current = true; setSaving(true); setError('');
    const fingerprint = JSON.stringify({ content, ids: attachments.map((a) => a.id), reasoning });
    const intent = pending.current?.fingerprint === fingerprint ? pending.current : {
      conversationId: activeId ?? crypto.randomUUID(), messageId: crypto.randomUUID(), fingerprint,
    };
    pending.current = intent;
    try {
      const { conversation } = await chatFetch<{ conversation: Conversation }>('', 'POST', {
        id: intent.conversationId, title: content.slice(0, 80) || t('agent.chat.imageConversation'),
      });
      const { turn } = await chatFetch<{ turn: ChatTurn }>(`/${conversation.id}/messages/${intent.messageId}`, 'PUT', {
        content, reasoning, attachmentIds: attachments.map((a) => a.id),
      });
      selection.current = conversation.id; restore.current = false;
      setConversations((items) => [conversation, ...items.filter((item) => item.id !== conversation.id)]);
      setDetail((current) => current?.conversation.id === conversation.id ? {
        ...current, turns: [...current.turns.filter((item) => item.id !== turn.id), turn],
      } : { conversation, turns: [turn], nextCursor: null });
      setActiveId(conversation.id); pending.current = null;
      // 消息落库之后**真的发起一次运行**（B-1）。失败不回滚消息：用户写下的
      // 内容必须保住，用它已保存的事实让用户决定是重试还是改目标。
      setRunError('');
      void startRun(content);
      return true;
    } catch (cause) { setError(t('agent.chat.saveFailedRetained', { reason: errorText(cause, t('common.operationFailed')) })); return false; }
    finally { locked.current = false; setSaving(false); }
  }

  /** 发起一次运行并轮询到终态；只在抽屉里展示，不阻塞输入。 */
  async function startRun(objective: string) {
    const generation = ++runGeneration.current;
    setRun(null);
    setRunError('');
    try {
      const response = await fetch('/api/agent/workspace/runs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 同一次提交（同一目标）的重试复用同一把键，避免重复建运行。
          'idempotency-key': `chat:${objective.length}:${objective.slice(0, 64)}`,
        },
        cache: 'no-store',
        body: JSON.stringify({ objective, execution: 'background' }),
      });
      const data = response.status === 204 ? null : await response.json();
      if (!response.ok) throw agentErrorFromBody(data);
      const created = (data as { run?: { id: string; status: string; steps: number; spendMinor: number; model: string | null; error: string | null } }).run;
      if (!created) return;
      if (generation !== runGeneration.current) return;
      setRun({ ...created, latest: null });
      void pollRun(created.id, generation);
    } catch (cause) {
      if (generation !== runGeneration.current) return;
      // 连运行都没建起来：原因必须留在**这一回合**下面。
      setRunError(agentErrorText(t, cause, t('agent.chat.runStartFailed')));
    }
  }

  /**
   * 轮询运行状态直到终态。
   *
   * 不用 SSE：运行本身可能几分钟，而抽屉只是「看进展」的轻量视图；2 秒一次的
   * GET 在后台执行（`execution: 'background'`）下足够，也避免长连接在切换对话时
   * 泄漏。
   */
  async function pollRun(runId: string, generation: number) {
    const terminal = new Set(['DONE', 'FAILED', 'CANCELLED']);
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (generation !== runGeneration.current || !openRef.current) return;
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 800 : 2000));
      if (generation !== runGeneration.current || !openRef.current) return;
      try {
        const detail = await chatFetch<RunDetail>(`/runs/${runId}`);
        if (generation !== runGeneration.current || !openRef.current) return;
        const last = detail.steps.at(-1);
        setRun({ ...detail.run, latest: runSummary(last) });
        if (terminal.has(detail.run.status)) return;
      } catch {
        // 轮询失败不打断输入；下一次重试。
      }
    }
  }

  async function loadMore() {
    if (!nextCursor || listLoading) return;
    const generation = listGeneration.current;
    setListLoading(true);
    try {
      const page = await chatFetch<Page>(`?search=${encodeURIComponent(search)}&cursor=${nextCursor}`);
      if (generation !== listGeneration.current) return;
      setConversations((items) => [...items, ...page.conversations.filter((row) => !items.some((item) => item.id === row.id))]);
      setNextCursor(page.nextCursor);
    } catch (cause) { setError(errorText(cause, t('agent.chat.loadFailed'))); }
    finally { if (generation === listGeneration.current) setListLoading(false); }
  }
  async function loadEarlier() {
    if (!detail?.nextCursor || loading) return;
    const conversationId = detail.conversation.id;
    setLoading(true);
    try {
      const page = await chatFetch<Detail>(`/${conversationId}?cursor=${detail.nextCursor}`);
      if (selection.current !== conversationId) return;
      setDetail((current) => current?.conversation.id === conversationId ? {
        ...current, turns: [...page.turns.filter((row) => !current.turns.some((item) => item.id === row.id)), ...current.turns], nextCursor: page.nextCursor,
      } : current);
    } catch (cause) { setError(errorText(cause, t('agent.chat.loadFailed'))); }
    finally { if (selection.current === conversationId) setLoading(false); }
  }
  async function rename(id: string, title: string) {
    if (locked.current) return false;
    locked.current = true; setSaving(true); setError('');
    try {
      const { conversation } = await chatFetch<{ conversation: Conversation }>(`/${id}`, 'PUT', { title });
      setConversations((items) => items.map((item) => item.id === id ? conversation : item));
      setDetail((current) => current?.conversation.id === id ? { ...current, conversation } : current);
      return true;
    } catch (cause) { setError(errorText(cause, t('common.operationFailed'))); return false; }
    finally { locked.current = false; setSaving(false); }
  }
  async function remove(id: string) {
    if (locked.current) return false;
    locked.current = true; setSaving(true); setError('');
    try {
      await chatFetch(`/${id}`, 'DELETE');
      setConversations((items) => items.filter((item) => item.id !== id));
      if (selection.current === id) { selection.current = null; setActiveId(null); setDetail(null); pending.current = null; }
      setRefresh((value) => value + 1);
      return true;
    } catch (cause) { setError(errorText(cause, t('common.operationFailed'))); return false; }
    finally { locked.current = false; setSaving(false); }
  }
  return {
    conversations, activeId, active: detail?.conversation.id === activeId ? { ...detail.conversation, turns: detail.turns } : null,
    nextCursor, earlierCursor: detail?.conversation.id === activeId ? detail.nextCursor : null,
    loading, listLoading, saving, error, submit, select, loadMore, loadEarlier, rename, remove,
    run, runError, cancelRun: () => {
      const id = run?.id;
      runGeneration.current += 1;
      setRun(null);
      if (id) void chatFetch(`/runs/${id}/cancel`, 'POST', {}).catch(() => undefined);
    },
    retry: () => setRefresh((value) => value + 1),
  };
}
