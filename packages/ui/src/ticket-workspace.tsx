'use client';

import { useState, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowDown,
  Check,
  Inbox,
  LoaderCircle,
  MessagesSquare,
  Search,
  Send,
  SquarePen,
} from 'lucide-react';
import { Button } from './button.js';
import { Input } from './input.js';
import { Field, FieldGroup } from './field.js';
import { Label } from './label.js';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupTextarea,
} from './input-group.js';
import { Message, MessageContent, MessageHeader, MessageFooter } from './message.js';
import { Bubble, BubbleContent } from './bubble.js';
import {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
} from './message-scroller.js';
import { cn } from './cn.js';

interface Ticket {
  id: string;
  subject: string;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
  userEmail?: string | null;
  assigneeEmail?: string | null;
  /** 分类 / 部门 / 关联业务对象（工单插件 #9 新增，均可缺省）。 */
  category?: string | null;
  departmentId?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  reminderCount?: number;
}
interface TicketDetail extends Ticket {
  assigneeId?: string | null;
  viewerId?: string | null;
  messages: Array<{
    id: string;
    body: string;
    authorId: string;
    authorRole?: string | null;
    authorEmail?: string | null;
    createdAt: string;
  }>;
}

/**
 * All user-facing copy for the ticket workspace.
 *
 * The primitive renders no copy of its own: `@stackpanel/ui` cannot read the
 * host's message catalogs, so whoever renders it (kernel or a plugin page)
 * resolves these strings from its own catalog and passes them in (ADR-0016 §6).
 * Every string is already final: the host interpolates its own placeholders.
 */
export interface TicketWorkspaceLabels {
  sectionAria: string;
  listAria: string;
  myTicketsAria: string;
  title: string;
  adminTitle: string;
  newTicketAria: string;
  searchAria: string;
  searchPlaceholder: string;
  emptySearch: string;
  empty: string;
  unknownUser: string;
  pickPrompt: string;
  backToListAria: string;
  newTitle: string;
  subjectLabel: string;
  subjectPlaceholder: string;
  bodyLabel: string;
  bodyPlaceholder: string;
  cancel: string;
  submit: string;
  sending: string;
  replyPlaceholder: string;
  replyAria: string;
  send: string;
  closed: string;
  notFound: string;
  statusLabel: string;
  priorityLabel: string;
  assigneeLabel: string;
  assigneePlaceholder: string;
  save: string;
  conversationAria: string;
  scrollLatestAria: string;
  latest: string;
  selfAuthor: string;
  staffAuthor: string;
  /** Label for the admin-only "internal note" checkbox on the reply form. */
  internalNote?: string;
  /** 「已催单 N 次」文案，`{count}` 会被替换。 */
  remindedTimes?: string;
  /** 管理端「分类」字段标签。 */
  categoryLabel?: string;
  categoryPlaceholder?: string;
  /** 管理端「部门」字段标签。 */
  departmentLabel?: string;
  /** 管理端回复框的「内部备注」勾选项文案。 */
  internalNoteLabel?: string;
  /** Display names for ticket status codes. Unknown codes fall back to the code. */
  statuses: Record<string, string>;
  /** Display names for ticket priority codes. Unknown codes fall back to the code. */
  priorities: Record<string, string>;
}

/**
 * Prevent a version-skewed runtime plugin from taking down its route while a
 * compatible revision is being published. The plugin normally supplies every
 * visible string; this deliberately renders empty copy instead of guessing a
 * locale in the shared host package.
 */
const missingTicketWorkspaceLabels: TicketWorkspaceLabels = {
  sectionAria: '',
  listAria: '',
  myTicketsAria: '',
  title: '',
  adminTitle: '',
  newTicketAria: '',
  searchAria: '',
  searchPlaceholder: '',
  emptySearch: '',
  empty: '',
  unknownUser: '',
  pickPrompt: '',
  backToListAria: '',
  newTitle: '',
  subjectLabel: '',
  subjectPlaceholder: '',
  bodyLabel: '',
  bodyPlaceholder: '',
  cancel: '',
  submit: '',
  sending: '',
  replyPlaceholder: '',
  replyAria: '',
  send: '',
  closed: '',
  notFound: '',
  statusLabel: '',
  priorityLabel: '',
  assigneeLabel: '',
  assigneePlaceholder: '',
  save: '',
  conversationAria: '',
  scrollLatestAria: '',
  latest: '',
  selfAuthor: '',
  staffAuthor: '',
  statuses: {},
  priorities: {},
};

function date(value: string, locale: string | undefined, short = false) {
  return new Date(value).toLocaleString(
    locale,
    short
      ? { month: 'numeric', day: 'numeric' }
      : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  );
}

function Submit({ label, sending }: { label: string; sending: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? (
        <LoaderCircle data-icon="inline-start" className="animate-spin" />
      ) : (
        <Send data-icon="inline-start" />
      )}
      {pending ? sending : label}
    </Button>
  );
}

interface TicketWorkspaceProps {
  tickets: Ticket[];
  ticket?: TicketDetail;
  mode: 'list' | 'new' | 'detail';
  create?: (data: FormData) => Promise<void>;
  reply?: (data: FormData) => Promise<void>;
  update?: (data: FormData) => Promise<void>;
  /**
   * Extra per-ticket operations (催单 / 关闭 / 内部备注开关等)。
   *
   * 共享组件不认识业务动词：内核不承担插件的工单语义，只提供挂载点，
   * 由插件把自己的 server action 注入进来（ADR-0016 §6）。
   */
  extraActions?: React.ReactNode;
  admin?: boolean;
  basePath?: string;
  /**
   * BCP 47 tag driving date/time presentation (ADR-0016 §6). The host supplies
   * it; the primitive never hardcodes a locale.
   */
  locale?: string;
  /** Localized copy. See {@link TicketWorkspaceLabels}. */
  labels?: TicketWorkspaceLabels;
}

/** Account support inbox; the plugin owns routes, data and server actions. */
export function TicketWorkspace({
  tickets,
  ticket,
  mode,
  create,
  reply,
  update,
  extraActions,
  admin = false,
  basePath = '/account/tickets',
  locale,
  labels = missingTicketWorkspaceLabels,
}: TicketWorkspaceProps) {
  const [search, setSearch] = useState('');
  const replyForm = useRef<HTMLFormElement>(null);
  const filtered = tickets.filter((item) =>
    `${item.subject} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const hasPanel = mode !== 'list';
  const statusLabel = (status: string): string => labels.statuses[status] ?? status;
  return (
    <section
      aria-label={labels.sectionAria}
      className="flex h-[calc(100svh-10rem)] min-h-[32rem] min-w-0 gap-6 text-foreground lg:gap-10"
    >
      <aside
        aria-label={labels.listAria}
        className={cn(
          'w-full shrink-0 flex-col md:flex md:w-64 lg:w-72',
          hasPanel ? 'hidden' : 'flex',
        )}
      >
        <div className="flex flex-col gap-5 pb-5 pt-1">
          <div className="flex items-center justify-between gap-3">
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              {admin ? labels.adminTitle : labels.title}{' '}
              <MessagesSquare className="size-4 text-muted-foreground" />
            </h1>
            {!admin && (
              <Button
                variant="ghost"
                size="icon"
                nativeButton={false}
                render={<Link href={`${basePath}/new`} />}
                aria-label={labels.newTicketAria}
              >
                <SquarePen />
              </Button>
            )}
          </div>
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={labels.searchAria}
              placeholder={labels.searchPlaceholder}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </InputGroup>
        </div>
        <nav
          aria-label={labels.myTicketsAria}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3"
        >
          {filtered.map((item) => (
            <Link
              key={item.id}
              href={`${basePath}/${encodeURIComponent(item.id)}`}
              aria-current={ticket?.id === item.id ? 'page' : undefined}
              className={cn(
                'flex flex-col gap-2 rounded-lg px-3 py-3.5 text-sm outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring',
                ticket?.id === item.id && 'bg-muted',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-medium">{item.subject}</span>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={item.updatedAt}>
                  {date(item.updatedAt, locale, true)}
                </time>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  {item.status === 'RESOLVED' || item.status === 'CLOSED' ? (
                    <Check className="size-3" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-primary/60" />
                  )}
                  {statusLabel(item.status)}
                </span>
                <span className="truncate">
                  {admin ? (item.userEmail ?? labels.unknownUser) : `#${item.id.slice(-8)}`}
                </span>
              </div>
            </Link>
          ))}
          {filtered.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground">
              <Inbox className="size-6 opacity-50" />
              <p>{search ? labels.emptySearch : labels.empty}</p>
            </div>
          )}
        </nav>
      </aside>
      <div
        className={cn(
          'min-w-0 flex-1 flex-col md:border-l md:border-border/60',
          hasPanel ? 'flex' : 'hidden md:flex',
        )}
      >
        {mode === 'list' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
            <MessagesSquare className="size-9 text-muted-foreground/50" />
            <h2 className="text-lg font-semibold">{labels.pickPrompt}</h2>
            {!admin && (
              <Button nativeButton={false} render={<Link href={`${basePath}/new`} />}>
                <SquarePen data-icon="inline-start" />
                {labels.newTitle}
              </Button>
            )}
          </div>
        ) : mode === 'new' ? (
          <>
            <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 pb-4 md:pl-8 lg:pl-10">
              <Button
                variant="ghost"
                size="icon"
                nativeButton={false}
                render={<Link href={basePath} />}
                aria-label={labels.backToListAria}
                className="md:hidden"
              >
                <ArrowLeft />
              </Button>
              <h2 className="text-base font-semibold">{labels.newTitle}</h2>
            </header>
            {create && (
              <form
                action={create}
                className="flex min-h-0 flex-1 flex-col overflow-y-auto py-8 md:pl-8 lg:pl-10"
              >
                <FieldGroup className="w-full max-w-2xl gap-7">
                  <Field>
                    <Label htmlFor="ticket-subject">{labels.subjectLabel}</Label>
                    <Input
                      id="ticket-subject"
                      name="subject"
                      placeholder={labels.subjectPlaceholder}
                      required
                      maxLength={191}
                    />
                  </Field>
                  <Field>
                    <Label htmlFor="ticket-body">{labels.bodyLabel}</Label>
                    <InputGroup className="items-stretch">
                      <InputGroupTextarea
                        id="ticket-body"
                        name="body"
                        placeholder={labels.bodyPlaceholder}
                        required
                        maxLength={10000}
                        rows={9}
                        className="min-h-56 resize-y"
                      />
                    </InputGroup>
                  </Field>
                </FieldGroup>
                <div className="mt-6 flex w-full max-w-2xl shrink-0 items-center justify-end gap-3">
                  <Button variant="ghost" nativeButton={false} render={<Link href={basePath} />}>
                    {labels.cancel}
                  </Button>
                  <Submit label={labels.submit} sending={labels.sending} />
                </div>
              </form>
            )}
          </>
        ) : ticket ? (
          <>
            <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border/60 pb-4 md:pl-8 lg:pl-10">
              <Button
                variant="ghost"
                size="icon"
                nativeButton={false}
                render={<Link href={basePath} />}
                aria-label={labels.backToListAria}
                className="md:hidden"
              >
                <ArrowLeft />
              </Button>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <h2 className="truncate text-base font-semibold">{ticket.subject}</h2>
                <p className="text-xs text-muted-foreground">
                  {admin ? (ticket.userEmail ?? labels.unknownUser) : `#${ticket.id.slice(-8)}`}
                  {ticket.category ? ` · ${ticket.category}` : ''}
                  {ticket.relatedType && ticket.relatedId
                    ? ` · ${ticket.relatedType}:${ticket.relatedId}`
                    : ''}
                  {ticket.reminderCount && ticket.reminderCount > 0
                    ? ` · ${labels.remindedTimes?.replace('{count}', String(ticket.reminderCount)) ?? ''}`
                    : ''}
                </p>
              </div>
              {extraActions ? (
                <div className="flex shrink-0 items-center gap-2">{extraActions}</div>
              ) : null}
              <span className="shrink-0 text-xs text-muted-foreground">
                {statusLabel(ticket.status)}
              </span>
            </header>
            {admin && update ? (
              <form
                action={update}
                className="grid gap-3 border-b border-border/60 pb-4 pt-4 md:pl-8 lg:pl-10 sm:grid-cols-3"
              >
                <input type="hidden" name="id" value={ticket.id} />
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium">{labels.statusLabel}</span>
                  <select
                    name="status"
                    defaultValue={ticket.status}
                    className="h-9 rounded-lg border bg-background px-2 text-sm"
                  >
                    {Object.entries(labels.statuses).map(([code, display]) => (
                      <option key={code} value={code}>
                        {display}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium">{labels.priorityLabel}</span>
                  <select
                    name="priority"
                    defaultValue={ticket.priority}
                    className="h-9 rounded-lg border bg-background px-2 text-sm"
                  >
                    {Object.entries(labels.priorities).map(([code, display]) => (
                      <option key={code} value={code}>
                        {display}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium">{labels.assigneeLabel}</span>
                  <Input
                    name="assigneeId"
                    defaultValue={ticket.assigneeId ?? ''}
                    placeholder={labels.assigneePlaceholder}
                    className="h-9"
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium">{labels.categoryLabel ?? '分类'}</span>
                  <Input
                    name="category"
                    defaultValue={ticket.category ?? ''}
                    placeholder={labels.categoryPlaceholder ?? ''}
                    className="h-9"
                    maxLength={64}
                  />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className="font-medium">{labels.departmentLabel ?? '部门 ID'}</span>
                  <Input
                    name="departmentId"
                    defaultValue={ticket.departmentId ?? ''}
                    className="h-9"
                  />
                </label>
                <div className="sm:col-span-3">
                  <Button type="submit" size="sm">
                    {labels.save}
                  </Button>
                </div>
              </form>
            ) : null}
            <MessageScrollerProvider key={ticket.id} autoScroll>
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent
                    className="py-6 md:pl-8 lg:pl-10"
                    aria-label={labels.conversationAria}
                  >
                    {ticket.messages.map((message) => {
                      const mine = message.authorId === ticket.viewerId;
                      return (
                        <MessageScrollerItem
                          key={message.id}
                          messageId={message.id}
                          scrollAnchor={mine}
                        >
                          <Message align={mine ? 'end' : 'start'}>
                            <MessageContent>
                              <MessageHeader>
                                {mine
                                  ? labels.selfAuthor
                                  : message.authorRole === 'ADMIN'
                                    ? labels.staffAuthor
                                    : (message.authorEmail ?? labels.staffAuthor)}
                              </MessageHeader>
                              <Bubble
                                variant={mine ? 'default' : 'muted'}
                                align={mine ? 'end' : 'start'}
                              >
                                <BubbleContent className="whitespace-pre-wrap">
                                  {message.body}
                                </BubbleContent>
                              </Bubble>
                              <MessageFooter>
                                <time dateTime={message.createdAt}>
                                  {date(message.createdAt, locale)}
                                </time>
                              </MessageFooter>
                            </MessageContent>
                          </Message>
                        </MessageScrollerItem>
                      );
                    })}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton aria-label={labels.scrollLatestAria}>
                  <ArrowDown />
                  <span className="sr-only">{labels.latest}</span>
                </MessageScrollerButton>
              </MessageScroller>
            </MessageScrollerProvider>
            {reply && ticket.status !== 'CLOSED' ? (
              <form
                ref={replyForm}
                action={async (data) => {
                  await reply(data);
                  replyForm.current?.reset();
                }}
                className="shrink-0 pt-4 md:pl-8 lg:pl-10"
              >
                <input type="hidden" name="id" value={ticket.id} />
                <InputGroup>
                  <InputGroupTextarea
                    name="body"
                    aria-label={labels.replyAria}
                    placeholder={labels.replyPlaceholder}
                    required
                    maxLength={10000}
                    rows={2}
                    className="max-h-40 min-h-20 resize-y"
                  />
                  <InputGroupAddon align="block-end">
                    <div className="flex flex-1 items-center gap-3">
                      {admin ? (
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input type="checkbox" name="internal" value="true" />
                          {labels.internalNoteLabel ?? '内部备注（用户不可见）'}
                        </label>
                      ) : null}
                      <div className="flex flex-1 justify-end">
                        <Submit label={labels.send} sending={labels.sending} />
                      </div>
                    </div>
                  </InputGroupAddon>
                </InputGroup>
              </form>
            ) : (
              <p className="shrink-0 border-t p-5 text-center text-sm text-muted-foreground">
                {labels.closed}
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {labels.notFound}
          </div>
        )}
      </div>
    </section>
  );
}
