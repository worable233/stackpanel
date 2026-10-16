'use client';

import { useState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { ArrowLeft, ArrowDown, Check, Inbox, LoaderCircle, MessagesSquare, Search, Send, SquarePen } from 'lucide-react';
import { Button } from './button.js';
import { Input } from './input.js';
import { Field, FieldGroup } from './field.js';
import { Label } from './label.js';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupTextarea } from './input-group.js';
import { Message, MessageContent, MessageHeader, MessageFooter } from './message.js';
import { Bubble, BubbleContent } from './bubble.js';
import { MessageScrollerProvider, MessageScroller, MessageScrollerViewport, MessageScrollerContent, MessageScrollerItem, MessageScrollerButton } from './message-scroller.js';
import { cn } from './cn.js';

interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
}
interface TicketDetail extends Ticket {
  viewerId?: string | null;
  messages: Array<{ id: string; body: string; authorId: string; authorRole?: string | null; authorEmail?: string | null; createdAt: string }>;
}
interface TicketWorkspaceProps {
  tickets: Ticket[];
  ticket?: TicketDetail;
  mode: 'list' | 'new' | 'detail';
  create?: (data: FormData) => Promise<void>;
  reply?: (data: FormData) => Promise<void>;
}
const statuses: Record<string, string> = { OPEN: '待处理', IN_PROGRESS: '处理中', RESOLVED: '已解决', CLOSED: '已关闭' };
function date(value: string, short = false) {
  return new Date(value).toLocaleString('zh-CN', short ? { month: 'numeric', day: 'numeric' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <Button type="submit" disabled={pending}>{pending ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Send data-icon="inline-start" />}{pending ? '发送中…' : label}</Button>;
}

/** Account support inbox; the plugin owns routes, data and server actions. */
export function TicketWorkspace({ tickets, ticket, mode, create, reply }: TicketWorkspaceProps) {
  const [search, setSearch] = useState('');
  const replyForm = useRef<HTMLFormElement>(null);
  const filtered = tickets.filter((item) => `${item.subject} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const hasPanel = mode !== 'list';
  return (
    <section aria-label="服务工单" className="flex h-[calc(100svh-10rem)] min-h-[32rem] min-w-0 gap-6 text-foreground lg:gap-10">
      <aside aria-label="工单列表" className={cn('w-full shrink-0 flex-col md:flex md:w-64 lg:w-72', hasPanel ? 'hidden' : 'flex')}>
        <div className="flex flex-col gap-5 pb-5 pt-1">
          <div className="flex items-center justify-between gap-3">
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">工单 <MessagesSquare className="size-4 text-muted-foreground" /></h1>
            <Button variant="ghost" size="icon" nativeButton={false} render={<Link href="/account/tickets/new" />} aria-label="提交工单"><SquarePen /></Button>
          </div>
          <InputGroup>
            <InputGroupAddon><Search /></InputGroupAddon>
            <InputGroupInput aria-label="搜索工单" placeholder="搜索工单…" value={search} onChange={(event) => setSearch(event.target.value)} />
          </InputGroup>
        </div>
        <nav aria-label="我的工单" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3">
          {filtered.map((item) => (
            <Link key={item.id} href={`/account/tickets/${encodeURIComponent(item.id)}`} aria-current={ticket?.id === item.id ? 'page' : undefined} className={cn('flex flex-col gap-2 rounded-lg px-3 py-3.5 text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring', ticket?.id === item.id && 'bg-muted')}>
              <div className="flex items-center justify-between gap-3"><span className="truncate font-medium">{item.subject}</span><time className="shrink-0 text-xs text-muted-foreground" dateTime={item.updatedAt}>{date(item.updatedAt, true)}</time></div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span className="flex items-center gap-1.5">{item.status === 'RESOLVED' || item.status === 'CLOSED' ? <Check className="size-3" /> : <span className="size-1.5 rounded-full bg-primary/60" />}{statuses[item.status] ?? item.status}</span><span className="truncate">#{item.id.slice(-8)}</span></div>
            </Link>
          ))}
          {filtered.length === 0 && <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground"><Inbox className="size-6 opacity-50" /><p>{search ? '未找到工单' : '暂无工单'}</p></div>}
        </nav>
      </aside>
      <div className={cn('min-w-0 flex-1 flex-col md:border-l md:border-border/60', hasPanel ? 'flex' : 'hidden md:flex')}>
        {mode === 'list' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
            <MessagesSquare className="size-9 text-muted-foreground/50" />
            <h2 className="text-lg font-semibold">选择工单，查看对话</h2>
            <Button nativeButton={false} render={<Link href="/account/tickets/new" />}><SquarePen data-icon="inline-start" />提交工单</Button>
          </div>
        ) : mode === 'new' ? (
          <>
            <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 pb-4 md:pl-8 lg:pl-10">
              <Button variant="ghost" size="icon" nativeButton={false} render={<Link href="/account/tickets" />} aria-label="返回工单列表" className="md:hidden"><ArrowLeft /></Button>
              <h2 className="text-base font-semibold">提交工单</h2>
            </header>
            {create && <form action={create} className="flex min-h-0 flex-1 flex-col overflow-y-auto py-8 md:pl-8 lg:pl-10">
              <FieldGroup className="w-full max-w-2xl gap-7">
                <Field><Label htmlFor="ticket-subject">主题</Label><Input id="ticket-subject" name="subject" placeholder="简要描述你需要的帮助" required maxLength={191} /></Field>
                <Field><Label htmlFor="ticket-body">问题描述</Label><InputGroup className="items-stretch"><InputGroupTextarea id="ticket-body" name="body" placeholder="描述遇到的问题，以及已经尝试的操作…" required maxLength={10000} rows={9} className="min-h-56 resize-y" /></InputGroup></Field>
              </FieldGroup>
              <div className="mt-6 flex w-full max-w-2xl shrink-0 items-center justify-end gap-3"><Button variant="ghost" nativeButton={false} render={<Link href="/account/tickets" />}>取消</Button><Submit label="提交工单" /></div>
            </form>}
          </>
        ) : ticket ? (
          <>
            <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 pb-4 md:pl-8 lg:pl-10">
              <Button variant="ghost" size="icon" nativeButton={false} render={<Link href="/account/tickets" />} aria-label="返回工单列表" className="md:hidden"><ArrowLeft /></Button>
              <div className="flex min-w-0 flex-1 flex-col gap-1"><h2 className="truncate text-base font-semibold">{ticket.subject}</h2><p className="text-xs text-muted-foreground">#{ticket.id.slice(-8)}</p></div>
              <span className="shrink-0 text-xs text-muted-foreground">{statuses[ticket.status] ?? ticket.status}</span>
            </header>
            <MessageScrollerProvider key={ticket.id} autoScroll>
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent className="py-6 md:pl-8 lg:pl-10" aria-label="工单对话">
                    {ticket.messages.map((message) => {
                      const mine = message.authorId === ticket.viewerId;
                      return <MessageScrollerItem key={message.id} messageId={message.id} scrollAnchor={mine}>
                        <Message align={mine ? 'end' : 'start'}><MessageContent>
                          <MessageHeader>{mine ? '我' : message.authorRole === 'ADMIN' ? '客服' : message.authorEmail ?? '客服'}</MessageHeader>
                          <Bubble variant={mine ? 'default' : 'muted'} align={mine ? 'end' : 'start'}><BubbleContent className="whitespace-pre-wrap">{message.body}</BubbleContent></Bubble>
                          <MessageFooter><time dateTime={message.createdAt}>{date(message.createdAt)}</time></MessageFooter>
                        </MessageContent></Message>
                      </MessageScrollerItem>;
                    })}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton aria-label="滚动到最新消息"><ArrowDown /><span className="sr-only">最新消息</span></MessageScrollerButton>
              </MessageScroller>
            </MessageScrollerProvider>
            {reply && ticket.status !== 'CLOSED' ? <form ref={replyForm} action={async (data) => { await reply(data); replyForm.current?.reset(); }} className="shrink-0 pt-4 md:pl-8 lg:pl-10">
              <input type="hidden" name="id" value={ticket.id} />
              <InputGroup>
                <InputGroupTextarea name="body" aria-label="回复内容" placeholder="输入回复…" required maxLength={10000} rows={2} className="max-h-40 min-h-20 resize-y" />
                <InputGroupAddon align="block-end"><div className="flex flex-1 justify-end"><Submit label="发送" /></div></InputGroupAddon>
              </InputGroup>
            </form> : <p className="shrink-0 border-t p-5 text-center text-sm text-muted-foreground">此工单已关闭</p>}
          </>
        ) : <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">工单不存在</div>}
      </div>
    </section>
  );
}
