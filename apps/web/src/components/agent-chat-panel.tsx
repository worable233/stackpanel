'use client';

import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import Image from 'next/image';
import { ArrowUp, Bot, Folder, ImagePlus, Loader2, MoreHorizontal, Pencil, Trash2, PanelLeft, Plus, Search, ShieldAlert, SquarePen, X } from 'lucide-react';
import { useAgentConversations, type ChatAttachment as Attachment } from '@/hooks/use-agent-conversations';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Field, FieldError, FieldGroup } from '@/components/ui/field';
import { AgentEffortPicker } from '@/components/agent-effort-picker';
import { AgentChatWindow } from '@/components/agent-chat-window';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

type AgentSidebarProps = { open: boolean; onOpenChange: (open: boolean) => void; contextLabel?: string };
const suggestions = ['检查云产品的运行状态', '整理待处理工单', '汇总最近的订单'];

/** Server-backed user conversations; saving history does not execute a platform action. */
export function AgentChatPanel({ open, onOpenChange, contextLabel = '当前工作区' }: AgentSidebarProps) {
  const [objective, setObjective] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [reasoning, setReasoning] = useState('均衡');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const [editing, setEditing] = useState<{ id: string; title: string; action: 'rename' | 'delete' } | null>(null);
  const history = useAgentConversations(open, search);
  const { active, activeId, conversations } = history;
  const busy = history.saving || uploading;
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const latestMessageId = active?.turns.at(-1)?.id;

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[role="menu"], [role="dialog"]')) {
        onOpenChange(false); trigger.current?.focus();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open, onOpenChange]);
  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [activeId, latestMessageId]);
  function close() { onOpenChange(false); trigger.current?.focus(); }
  function newChat() { if (busy) return; history.select(null); setObjective(''); setAttachments([]); setAttachmentError(''); if (innerWidth < 820) setSidebarOpen(false); input.current?.focus(); }
  async function submit() {
    if (busy || history.loading || (!objective.trim() && !attachments.length)) return;
    if (await history.submit(objective.trim(), attachments, reasoning)) {
      setObjective(''); setAttachments([]); setAttachmentError('');
    }
  }
  async function selectFiles(files: FileList | readonly File[] | null) {
    if (!files || busy || uploadLock.current) return;
    const selected = Array.from(files);
    if (selected.some((file) => !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) || selected.length + attachments.length > 4) {
      setAttachmentError('最多选择 4 张 PNG、JPEG、GIF 或 WebP 图片，每张不超过 5 MB。'); return;
    }
    uploadLock.current = true; setUploading(true); setAttachmentError('');
    try {
      for (const file of selected) {
        const response = await fetch(`/api/agent/attachments?filename=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'content-type': file.type }, body: file,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || '图片上传失败');
        setAttachments((items) => [...items, data.attachment]);
      }
    } catch (cause) { setAttachmentError(cause instanceof Error ? cause.message : '图片上传失败'); }
    finally { uploadLock.current = false; setUploading(false); }
  }
  function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboard = event.clipboardData;
    const imageItems = Array.from(clipboard.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    const images = imageItems.length ? imageItems : Array.from(clipboard.files).filter((file) => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    if (busy || uploadLock.current) return;
    // Keep accompanying plain text without pasting HTML or an image data URL into the message.
    const text = clipboard.getData('text/plain');
    if (text) {
      const { selectionStart, selectionEnd } = event.currentTarget;
      setObjective((current) => (current.slice(0, selectionStart) + text + current.slice(selectionEnd)).slice(0, 4000));
    }
    void selectFiles(images);
  }
  const sidebar = sidebarOpen ? <>
    <div data-agent-drag-handle title="拖动标题栏移动面板" className="flex h-13 shrink-0 items-center justify-between px-3 sm:cursor-grab sm:touch-none sm:select-none sm:active:cursor-grabbing"><span className="text-sm font-semibold">Agent</span><Button variant="ghost" size="icon-sm" aria-label="收起对话侧边栏" onClick={() => setSidebarOpen(false)}><PanelLeft /></Button></div>
    <div className="flex items-center justify-between px-3 pb-2"><span className="text-xs text-muted-foreground">{contextLabel}</span><Button variant="ghost" size="icon-sm" aria-label="搜索对话" onClick={() => setSearchOpen(!searchOpen)}><Search /></Button></div>
    {searchOpen && <div className="px-3 pb-2"><Input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索对话…" aria-label="搜索对话" /></div>}
    <div className="px-2"><Button variant="ghost" className="w-full justify-start" disabled={busy} onClick={newChat}><SquarePen data-icon="inline-start" />新建对话</Button></div>
    <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <p className="px-2 pb-2 text-xs text-muted-foreground">对话记录</p>
      <div className="flex flex-col gap-1">{conversations.map((conversation) => <div key={conversation.id} className="group flex items-center gap-1">
        <Button disabled={busy} variant={activeId === conversation.id ? 'secondary' : 'ghost'} className="min-w-0 flex-1 justify-start" onClick={() => { history.select(conversation.id); setObjective(''); setAttachments([]); if (innerWidth < 820) setSidebarOpen(false); }}><span className="truncate">{conversation.title}</span></Button>
        <DropdownMenu><DropdownMenuTrigger disabled={busy} render={<Button variant="ghost" size="icon-xs" aria-label={`对话选项 ${conversation.title}`} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>
          <DropdownMenuItem onClick={() => setEditing({ ...conversation, action: 'rename' })}><Pencil />重命名</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setEditing({ ...conversation, action: 'delete' })}><Trash2 />删除对话</DropdownMenuItem>
        </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
      </div>)}</div>
      {history.listLoading && <p role="status" className="px-2 py-4 text-xs text-muted-foreground">正在加载…</p>}
      {!history.listLoading && !conversations.length && <p className="px-2 py-4 text-xs text-muted-foreground">{search ? '没有匹配的对话' : '暂无对话'}</p>}
      {history.nextCursor && <Button variant="ghost" size="sm" disabled={history.listLoading} onClick={() => void history.loadMore()}>加载更多</Button>}
    </div>
    <p className="px-4 py-3 text-xs text-muted-foreground">对话保存在当前账户中</p>
  </> : undefined;

  return <>
    <Dialog open={Boolean(editing)} onOpenChange={(value) => { if (!value && !history.saving) setEditing(null); }}>
      <DialogContent className="max-w-sm"><DialogHeader><DialogTitle>{editing?.action === 'delete' ? '删除对话' : '重命名对话'}</DialogTitle><DialogDescription>{editing?.action === 'delete' ? '删除后无法恢复该对话及消息记录。' : '设置一个便于查找的名称。'}</DialogDescription></DialogHeader>
        <form className="mt-4 flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (!editing) return; void (editing.action === 'delete' ? history.remove(editing.id) : history.rename(editing.id, editing.title.trim())).then((ok) => { if (ok) setEditing(null); }); }}>
          {editing?.action === 'rename' && <FieldGroup><Field><Label htmlFor="agent-conversation-title">名称</Label><Input id="agent-conversation-title" autoFocus maxLength={200} value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} /></Field></FieldGroup>}
          {history.error && <FieldError role="alert">{history.error}</FieldError>}
          <DialogFooter><Button type="button" variant="ghost" disabled={history.saving} onClick={() => setEditing(null)}>取消</Button><Button type="submit" variant={editing?.action === 'delete' ? 'destructive' : 'default'} disabled={history.saving || (editing?.action === 'rename' && !editing.title.trim())}>{history.saving ? '处理中…' : editing?.action === 'delete' ? '删除' : '保存'}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Button ref={trigger} variant="ghost" size="icon" aria-label={open ? '收起 Agent' : '打开 Agent'} aria-expanded={open} aria-controls={open ? 'agent-workspace' : undefined} onClick={() => onOpenChange(!open)}><Bot /></Button>
    <AgentChatWindow open={open} sidebar={sidebar} header={<>
      <div className="flex min-w-0 flex-1 items-center gap-3">{!sidebarOpen && <Button variant="ghost" size="icon-sm" aria-label="展开对话侧边栏" aria-expanded={false} onClick={() => setSidebarOpen(true)}><PanelLeft /></Button>}<Folder className="size-4 shrink-0 text-muted-foreground" /><h2 className="truncate text-sm font-medium">{active?.title || 'Agent'}</h2></div>
      <Button variant="ghost" size="icon-sm" aria-label="关闭 Agent" onClick={close}><X /></Button>
    </>}>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6 pt-5" aria-live="polite" data-agent-conversation>
        {history.error && <div className="mb-4 flex items-center gap-2"><FieldError role="alert">{history.error}</FieldError><Button variant="ghost" size="sm" onClick={history.retry}>重试加载</Button></div>}
        {history.loading && !active && <p role="status" className="py-4 text-sm text-muted-foreground">正在加载对话…</p>}
        {history.earlierCursor && <Button variant="ghost" size="sm" disabled={history.loading} onClick={() => void history.loadEarlier()}>加载更早的消息</Button>}
        {active ? <div className="flex flex-col gap-10">{active.turns.map((turn) => <section key={turn.id} className="flex flex-col gap-7">
          <div className="ml-8 flex max-w-[90%] flex-col gap-2 self-end rounded-3xl bg-muted px-4 py-3 text-sm leading-6 break-words">{turn.attachments.length > 0 && <div className="flex flex-wrap gap-2">{turn.attachments.map((attachment) => <Image key={attachment.id} src={attachment.url} alt={attachment.name} width={80} height={80} unoptimized className="size-20 rounded-lg object-cover" />)}</div>}{turn.objective}</div>
          <p className="text-xs text-muted-foreground">消息已保存 · 尚未启动 Agent 执行</p>
        </section>)}</div> : !activeId && <section className="flex h-full flex-col justify-center gap-6 pb-10"><div><h3 className="text-xl font-medium tracking-tight">有什么需要帮忙的？</h3><p className="mt-2 text-sm text-muted-foreground">描述你想完成的任务。</p></div><div className="flex flex-col items-start gap-1">{suggestions.map((suggestion) => <Button key={suggestion} variant="ghost" className="h-auto max-w-full justify-start py-2" onClick={() => { setObjective(suggestion); input.current?.focus(); }}><span className="truncate">{suggestion}</span></Button>)}</div></section>}
      </div>
      <form className="shrink-0 px-3 pb-3 pt-1" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" tabIndex={-1} aria-label="添加图片" onChange={(event) => { void selectFiles(event.target.files).catch(() => setAttachmentError('图片读取失败，请重试。')); event.target.value = ''; }} />
        <InputGroup className="overflow-hidden rounded-3xl bg-card shadow-lg shadow-foreground/5 has-disabled:bg-card has-disabled:opacity-100 dark:bg-card dark:has-disabled:bg-card">
          {attachments.length > 0 && <InputGroupAddon align="block-start" className="flex-wrap gap-3 px-3.5 pt-3.5">{attachments.map((attachment) => <div key={attachment.id} className="relative"><Image src={attachment.url} alt={attachment.name} width={80} height={80} unoptimized className="size-20 rounded-xl border border-border object-cover" /><Button variant="secondary" size="icon-xs" type="button" className="absolute -right-1 -top-1 rounded-full" disabled={busy} aria-label={`移除图片 ${attachment.name}`} onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}><X /></Button></div>)}</InputGroupAddon>}
          <InputGroupTextarea disabled={busy} ref={input} onPaste={pasteImages} value={objective} onChange={(event) => setObjective(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} maxLength={4000} rows={2} aria-label="Agent 任务目标" placeholder="向 Agent 提问…" className="max-h-40 min-h-24 resize-none px-4 py-4" />
          <InputGroupAddon align="block-end" className="gap-1 px-3 pb-3">
            <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={busy} aria-label="添加附件或上下文" />}><Plus /></DropdownMenuTrigger><DropdownMenuContent side="top" className="w-52"><DropdownMenuGroup><DropdownMenuItem onClick={() => fileInput.current?.click()}><ImagePlus />添加图片</DropdownMenuItem><DropdownMenuItem disabled><Folder />{contextLabel}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
            <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="执行权限" />}><ShieldAlert /></DropdownMenuTrigger><DropdownMenuContent side="top" className="w-56"><DropdownMenuGroup><DropdownMenuLabel>执行权限</DropdownMenuLabel><DropdownMenuItem disabled><ShieldAlert />当前仅保存对话，不执行操作</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
            <div className="flex-1" />
            <AgentEffortPicker value={reasoning} onChange={setReasoning} disabled={busy} />
            <Button type="submit" size="icon" disabled={busy || history.loading || (!objective.trim() && !attachments.length)} aria-label="发送消息" className="rounded-full bg-foreground text-background hover:bg-foreground/85">{busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button>
          </InputGroupAddon>
        </InputGroup>
        {uploading && <p role="status" className="mt-2 px-2 text-xs text-muted-foreground">正在上传私有图片…</p>}
        {attachmentError && <p role="alert" className="mt-2 px-2 text-xs text-destructive">{attachmentError}</p>}
      </form>
    </AgentChatWindow>
  </>;
}
