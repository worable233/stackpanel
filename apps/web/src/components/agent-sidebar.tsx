'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, Bot, Check, ChevronDown, ChevronRight, Clock3, FileText, History, Layers, Plus, ShieldCheck, Sparkles, X } from 'lucide-react';
import { AgentFloatingFrame } from '@/components/agent-floating-frame';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from '@/components/ui/input-group';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

type AgentSidebarProps = { open: boolean; onOpenChange: (open: boolean) => void; contextLabel?: string };
type Draft = { id: string; objective: string; time: string };
const suggestions = ['检查云产品的运行状态', '整理待处理工单', '汇总最近的订单'];

/** Visual preview only. The integrated Agent pages remain available separately. */
export function AgentSidebar({ open, onOpenChange, contextLabel = '当前工作区' }: AgentSidebarProps) {
  const [objective, setObjective] = useState('');
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [active, setActive] = useState<Draft | null>(null);
  const [history, setHistory] = useState(false);
  const [context, setContext] = useState('当前页面');
  const [showDraft, setShowDraft] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      // Let a nested menu consume Escape before closing the window.
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[role="menu"]')) {
        onOpenChange(false); trigger.current?.focus();
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open, onOpenChange]);
  function close() { onOpenChange(false); trigger.current?.focus(); }
  function newTask() { setActive(null); setObjective(''); setHistory(false); setShowDraft(false); input.current?.focus(); }
  function submit() {
    if (!objective.trim()) return;
    const draft = { id: crypto.randomUUID(), objective: objective.trim(), time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) };
    setDrafts((items) => [draft, ...items]); setActive(draft); setObjective(''); setHistory(false); setShowDraft(false);
  }
  return <>
    <Button ref={trigger} variant="ghost" size="icon" aria-label={open ? '收起 Agent' : '打开 Agent'} aria-expanded={open} aria-controls={open ? 'agent-workspace' : undefined} onClick={() => onOpenChange(!open)}><Bot /></Button>
    <AgentFloatingFrame open={open} header={<>
      <div className="flex min-w-0 items-center gap-2"><Bot className="size-4" /><h2 className="text-sm font-semibold">Agent</h2><Badge variant="secondary">预览</Badge></div>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" aria-label="新任务" title="新任务" onClick={newTask}><Plus /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="本次预览记录" title="本次预览记录" aria-pressed={history} onClick={() => setHistory(!history)}><History /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="关闭 Agent" onClick={close}><X /></Button>
      </div>
    </>}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-3" aria-live="polite">
        {history ? <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between"><h3 className="text-sm font-medium">本次预览记录</h3><span className="text-xs text-muted-foreground">{drafts.length} 条</span></div>
          {drafts.length ? <div className="flex flex-col gap-1"><p className="px-2 pb-1 text-xs text-muted-foreground">今天</p>{drafts.map((draft) => <Button key={draft.id} variant={active?.id === draft.id ? 'secondary' : 'ghost'} className="h-auto w-full justify-start py-2.5" onClick={() => { setActive(draft); setHistory(false); setShowDraft(false); }}><span className="flex min-w-0 flex-1 items-center gap-2"><FileText className="shrink-0" /><span className="truncate">{draft.objective}</span></span><span className="text-xs text-muted-foreground">{draft.time}</span></Button>)}</div> : <p className="py-12 text-center text-sm text-muted-foreground">暂无任务</p>}
        </section> : active ? <div key={active.id} className="flex flex-col gap-6">
          <div className="ml-8 self-end rounded-2xl bg-muted px-4 py-3 text-sm leading-6 break-words">{active.objective}</div>
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"><Clock3 className="size-3.5" />任务预览 · 尚未执行<ChevronRight className="size-3.5 transition-transform group-open:rotate-90" /></summary>
            <ol className="ml-1.5 mt-3 flex flex-col gap-3 border-l border-border pl-4 text-xs leading-5 text-muted-foreground"><li className="flex items-center gap-2"><Check className="size-3.5" />已记录任务目标</li><li className="flex items-center gap-2"><Clock3 className="size-3.5" />等待连接 Agent 运行服务</li></ol>
          </details>
          <div className="flex flex-col gap-3 text-sm leading-6"><p>任务已整理为草稿。</p><p className="text-muted-foreground">接入运行服务后，将在这里展示检查结果和需要确认的操作。</p></div>
          <section className="overflow-hidden rounded-xl border border-border/70">
            <div className="flex items-center gap-3 px-3.5 py-3"><FileText className="size-4 shrink-0 text-muted-foreground" /><div className="flex min-w-0 flex-1 flex-col gap-0.5"><h3 className="text-sm font-medium">任务草稿</h3><p className="text-xs text-muted-foreground">仅保留在本次预览中</p></div><Button variant="ghost" size="xs" aria-expanded={showDraft} onClick={() => setShowDraft(!showDraft)}>查看<ChevronRight data-icon="inline-end" /></Button></div>
            {showDraft && <p className="border-t border-border/60 px-3.5 py-3 text-sm leading-6 break-words">{active.objective}</p>}
          </section>
          <Button variant="ghost" size="xs" className="self-start" onClick={newTask}><Plus data-icon="inline-start" />新建任务</Button>
        </div> : <section className="flex flex-col gap-7 pb-4 pt-10">
          <div className="flex flex-col gap-3"><Sparkles className="size-6 text-muted-foreground" /><h3 className="text-xl font-semibold tracking-tight">今天有什么需要处理？</h3><p className="text-sm leading-6 text-muted-foreground">从一个问题，或一项任务开始。</p></div>
          <div className="flex flex-col gap-1">{suggestions.map((suggestion) => <Button key={suggestion} variant="ghost" className="h-auto justify-between py-2.5" onClick={() => { setObjective(suggestion); input.current?.focus(); }}><span className="truncate">{suggestion}</span><ArrowUpRight data-icon="inline-end" /></Button>)}</div>
        </section>}
      </div>
      <form className="shrink-0 px-3 pb-3 pt-2" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <InputGroup className="rounded-2xl shadow-sm">
          <InputGroupTextarea ref={input} value={objective} onChange={(event) => setObjective(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} maxLength={4000} rows={2} aria-label="Agent 任务目标" placeholder="向 Agent 提问，或描述任务…" className="max-h-40 min-h-22 resize-none px-3.5" />
          <InputGroupAddon align="block-end" className="gap-1">
            <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="选择上下文" />}><Plus /></DropdownMenuTrigger><DropdownMenuContent side="top" className="w-52"><DropdownMenuGroup><DropdownMenuLabel>任务上下文</DropdownMenuLabel>{['当前页面', contextLabel].map((label) => <DropdownMenuItem key={label} onClick={() => setContext(label)}><Layers />{label}{context === label && <Check className="ml-auto" />}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
            <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">{context}</span>
            <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="xs" aria-label="查看执行权限" />}><ShieldCheck data-icon="inline-start" />仅预览<ChevronDown data-icon="inline-end" /></DropdownMenuTrigger><DropdownMenuContent side="top" align="end" className="w-60"><DropdownMenuGroup><DropdownMenuLabel>执行权限</DropdownMenuLabel><DropdownMenuItem disabled><ShieldCheck />当前为界面预览，不执行操作</DropdownMenuItem><DropdownMenuItem render={<Link href="/account/agent" />}><ArrowUpRight />前往 Agent 工作区</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
            <Button type="submit" size="icon-sm" disabled={!objective.trim()} aria-label="预览 Agent 任务" className="rounded-full"><ArrowUp /></Button>
          </InputGroupAddon>
        </InputGroup>
        <p className="mt-2 text-center text-[11px] leading-5 text-muted-foreground">界面预览，尚未连接运行服务</p>
      </form>
    </AgentFloatingFrame>
  </>;
}
