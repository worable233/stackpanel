'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type ChatAttachment = { id: string; name: string; url: string };
export type ChatTurn = { id: string; objective: string; attachments: ChatAttachment[]; created: number; reasoning: string };
type Conversation = { id: string; title: string; createdAt: string; updatedAt: string };
type Page = { conversations: Conversation[]; nextCursor: string | null };
type Detail = { conversation: Conversation; turns: ChatTurn[]; nextCursor: string | null };

async function chatFetch<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/agent/conversations${path}`, {
    method, headers: { 'content-type': 'application/json' }, cache: 'no-store', signal,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(data?.detail || data?.error || '无法加载对话，请重试');
  return data;
}

export function useAgentConversations(open: boolean, search: string) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
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
      }).catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); })
        .finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    }, search ? 250 : 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, search, refresh]);

  useEffect(() => {
    if (!open || !activeId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setError('');
      void chatFetch<Detail>(`/${activeId}`, 'GET', undefined, controller.signal).then((data) => {
      if (!controller.signal.aborted) setDetail(data);
    }).catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [open, activeId, refresh]);

  const select = useCallback((id: string | null) => {
    if (locked.current) return;
    restore.current = false; selection.current = id; pending.current = null;
    setActiveId(id); setDetail(null); setLoading(false); setError('');
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
        id: intent.conversationId, title: content.slice(0, 80) || '图片对话',
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
      return true;
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : '保存失败'}。输入内容已保留，可重试保存。`); return false; }
    finally { locked.current = false; setSaving(false); }
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
    } catch (cause) { setError((cause as Error).message); }
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
    } catch (cause) { setError((cause as Error).message); }
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
    } catch (cause) { setError((cause as Error).message); return false; }
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
    } catch (cause) { setError((cause as Error).message); return false; }
    finally { locked.current = false; setSaving(false); }
  }
  return {
    conversations, activeId, active: detail?.conversation.id === activeId ? { ...detail.conversation, turns: detail.turns } : null,
    nextCursor, earlierCursor: detail?.conversation.id === activeId ? detail.nextCursor : null,
    loading, listLoading, saving, error, submit, select, loadMore, loadEarlier, rename, remove,
    retry: () => setRefresh((value) => value + 1),
  };
}
