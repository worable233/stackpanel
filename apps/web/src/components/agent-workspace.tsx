'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group';
import { Field, FieldDescription, FieldError, FieldGroup } from '@/components/ui/field';
import { Label as FieldLabel } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Run = { id: string; objective: string; status: string; model: string; steps: number; spendMinor: number; error?: string };
type Approval = { id: string; runId: string; capabilityId: string; args: unknown; expiresAt: string; run: { objective: string } };
type Server = { id: string; name: string; credentialConfigured: boolean };
type Step = { id: string; index: number; kind: string; toolName?: string; args?: unknown; result?: unknown; error?: string; costMinor: number };
export async function agentFetch<T>(path: string, method = 'GET', body?: unknown, key?: string, idempotency?: string): Promise<T> {
  const res = await fetch(`/api/agent/${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-agent-key': key } : {}), ...(idempotency ? { 'idempotency-key': idempotency } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail ?? data.message ?? data.error ?? '操作失败');
  return data as T;
}
export function JsonView({ value }: { value: unknown }) { return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>; }

export function AgentWorkspace({ runId, approvalsOnly = false }: { runId?: string; approvalsOnly?: boolean }) {
  const [status, setStatus] = useState<{ enabled: boolean; modelConfigured: boolean; provider: { name: string } | null }>();
  const [key, setKey] = useState(''); const [objective, setObjective] = useState('');
  const [model, setModel] = useState(''); const [models, setModels] = useState<Array<{id:string;label:string}>>([]);
  const [execution, setExecution] = useState('request'); const [autonomy, setAutonomy] = useState('read');
  const [runs, setRuns] = useState<Run[]>([]); const [next, setNext] = useState<string | null>(null);
  const [run, setRun] = useState<Run>(); const [steps, setSteps] = useState<Step[]>([]);
  const [family, setFamily] = useState<Array<{id:string;objective:string;status:string}>>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]); const [approvalNext, setApprovalNext] = useState<string | null>(null); const [reason, setReason] = useState('');
  const [servers, setServers] = useState<Server[]>([]); const [credentials, setCredentials] = useState<Record<string,string>>({});
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const createIntent = useRef<{body:string;id:string} | null>(null);
  const refresh = useCallback(async () => {
    const current = await agentFetch<typeof status>('status'); setStatus(current);
    const pending = await agentFetch<{approvals:Approval[];nextCursor:string|null}>('approvals'); setApprovals(pending.approvals); setApprovalNext(pending.nextCursor);
    if (runId) {
      const detail = await agentFetch<{run:Run;steps:Step[];family:Array<{id:string;objective:string;status:string}>}>(`runs/${runId}`);
      setRun(detail.run); setSteps(detail.steps); setFamily(detail.family);
    } else if (!approvalsOnly) {
      const list = await agentFetch<{runs:Run[];nextCursor:string|null}>('runs'); setRuns(list.runs); setNext(list.nextCursor);
      const external = await agentFetch<{servers:Server[]}>('mcp-servers'); setServers(external.servers);
      const available = await agentFetch<{models:Array<{id:string;label:string}>}>('models'); setModels(available.models);
    }
  }, [runId, approvalsOnly]);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { try { if (active) await refresh(); } catch (cause) { if (active) setError(String(cause instanceof Error ? cause.message : cause)); } finally { if (active && runId) timer = setTimeout(tick, 5000); } };
    void tick(); return () => { active = false; clearTimeout(timer); };
  }, [refresh]);
  async function act(action: () => Promise<unknown>, reload = true) { setBusy(true); setError(''); try { await action(); if(reload) await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); } finally { setBusy(false); } }
  async function start(parentId?: string) {
    if (!key.trim()) throw new Error('请填写本人的权限 API Key');
    const body = { objective, ...(model ? {model} : {}), autonomy, execution, ...(parentId ? {parentId} : {}) };
    const serialized = JSON.stringify(body);
    if (createIntent.current?.body !== serialized) createIntent.current = {body:serialized,id:crypto.randomUUID()};
    const result = await agentFetch<{run:Run}>('runs', 'POST', body, key.trim(), createIntent.current.id);
    createIntent.current = null; setObjective(''); window.location.assign(`/account/agent/runs/${result.run.id}`);
  }
  return <div className="flex flex-col gap-6 p-6">
    <nav className="flex flex-wrap gap-3"><Link href="/account/agent">Agent 任务</Link><Link href="/account/agent/approvals">待审批</Link><Link href="/account/settings#security">权限密钥</Link></nav>
    <h1>{approvalsOnly ? 'Agent 审批' : run ? run.objective : 'Agent 工作区'}</h1>
    <p>{status?.enabled ? `本站已开启 · 模型提供方：${status.provider?.name ?? '尚未配置'}` : '本站尚未开放 Agent'}</p>
    <FieldError role="alert">{error}</FieldError>
    {!approvalsOnly && <Card><CardHeader><CardTitle>{run ? '继续执行与子任务' : '新建任务'}</CardTitle><CardDescription>权限取决于所用 API Key。危险写操作始终需要本人确认。后台授权加密保管原 Key，最长一小时，到期停止。</CardDescription></CardHeader><CardContent>
      <form onSubmit={(event) => { event.preventDefault(); void act(() => start(runId)); }}><FieldGroup>
        <Field><FieldLabel htmlFor="agent-key">本人的权限 API Key</FieldLabel><Input id="agent-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /><FieldDescription>仅保留在当前页面内存；切换页面后需重新输入。模型密钥由站长管理。</FieldDescription></Field>
        <Field><FieldLabel htmlFor="agent-objective">{run ? '子任务目标' : '任务目标'}</FieldLabel><InputGroup><InputGroupTextarea id="agent-objective" value={objective} maxLength={4000} onChange={(e) => setObjective(e.target.value)} /></InputGroup></Field>
        <Field><FieldLabel htmlFor="agent-model">模型（留空使用默认）</FieldLabel><Input id="agent-model" list="agent-models" value={model} onChange={(e) => setModel(e.target.value)} /><datalist id="agent-models">{models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist></Field>
        <Field><FieldLabel>执行方式</FieldLabel><Select value={execution} onValueChange={(v) => v && setExecution(v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="request">本次请求推进</SelectItem><SelectItem value="background">授权后台持续执行（一小时）</SelectItem></SelectGroup></SelectContent></Select></Field>
        <Field><FieldLabel>自主度（受 Key 策略上限约束）</FieldLabel><Select value={autonomy} onValueChange={(v) => v && setAutonomy(v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="read">只读，写入需确认</SelectItem><SelectItem value="propose">提议后确认写入</SelectItem><SelectItem value="act">自动执行普通写入</SelectItem></SelectGroup></SelectContent></Select></Field>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || !status?.enabled || !status.modelConfigured || !objective.trim()}>{run ? '创建子任务' : '开始任务'}</Button>{run && <><Button type="button" variant="outline" disabled={busy || !key || !['QUEUED','RUNNING','WAITING_APPROVAL'].includes(run.status)} onClick={() => void act(() => agentFetch(`runs/${run.id}/resume`, 'POST', {execution}, key))}>使用原 Key 继续</Button><Button type="button" variant="destructive" disabled={busy || !['QUEUED','RUNNING','WAITING_APPROVAL'].includes(run.status)} onClick={() => void act(() => agentFetch(`runs/${run.id}/cancel`, 'POST', {}))}>取消任务</Button></>}</div>
      </FieldGroup></form>
    </CardContent></Card>}
    {run && <Card><CardHeader><CardTitle>执行回放 <Badge>{run.status}</Badge></CardTitle><CardDescription>{run.steps} 步 · 模型费用 {run.spendMinor} 最小货币单位 · {run.model}</CardDescription></CardHeader><CardContent><FieldError>{run.error}</FieldError>{steps.map((step) => <details key={step.id}><summary>第 {step.index + 1} 步 · {step.kind} {step.toolName}</summary><JsonView value={step} /></details>)}{family.map((item) => <p key={item.id}><Link href={`/account/agent/runs/${item.id}`}>{item.objective}</Link> · {item.status}</p>)}</CardContent></Card>}
    {!runId && !approvalsOnly && <Card><CardHeader><CardTitle>任务记录</CardTitle></CardHeader><CardContent>{!runs.length && <p>暂无任务</p>}{runs.map((item) => <p key={item.id}><Link href={`/account/agent/runs/${item.id}`}>{item.objective}</Link> <Badge variant="secondary">{item.status}</Badge></p>)}{next && <Button variant="outline" disabled={busy} onClick={() => void act(async () => { const page = await agentFetch<{runs:Run[];nextCursor:string|null}>(`runs?cursor=${next}`); setRuns((rows) => [...rows, ...page.runs]); setNext(page.nextCursor); }, false)}>加载更多任务</Button>}</CardContent></Card>}
    <Card><CardHeader><CardTitle>待确认操作</CardTitle><CardDescription>批准仅记录决定。请求执行模式需原 Key 继续；已授权的后台任务会自动推进。请核对工具、参数和副作用。</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel htmlFor="approval-reason">审批说明</FieldLabel><Input id="approval-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>{!approvals.length && <p>暂无待审批操作</p>}{approvals.filter((item) => !runId || item.runId === runId).map((item) => <Card key={item.id}><CardHeader><CardTitle>{item.capabilityId}</CardTitle><CardDescription>{item.run.objective} · 到期：{item.expiresAt}</CardDescription></CardHeader><CardContent><JsonView value={item.args} /><div className="flex gap-2"><Button disabled={busy} onClick={() => void act(() => agentFetch(`approvals/${item.id}/decide`, 'POST', {approve:true,reason}))}>确认本次操作</Button><Button variant="outline" disabled={busy} onClick={() => void act(() => agentFetch(`approvals/${item.id}/decide`, 'POST', {approve:false,reason}))}>拒绝</Button><Link href={`/account/agent/runs/${item.runId}`}>查看任务</Link></div></CardContent></Card>)}{approvalNext && <Button variant="outline" disabled={busy} onClick={() => void act(async () => { const page = await agentFetch<{approvals:Approval[];nextCursor:string|null}>(`approvals?cursor=${approvalNext}`); setApprovals((rows) => [...rows,...page.approvals]); setApprovalNext(page.nextCursor); }, false)}>加载更多审批</Button>}</FieldGroup></CardContent></Card>
    {!runId && !approvalsOnly && <Card><CardHeader><CardTitle>外部服务凭证</CardTitle><CardDescription>服务清单由站长审核；权限通过普通权限组授予。密钥保存后不回显。</CardDescription></CardHeader><CardContent><FieldGroup>{!servers.length && <p>暂无可用外部服务</p>}{servers.map((server) => <Field key={server.id}><FieldLabel htmlFor={`credential-${server.id}`}>{server.name} · {server.credentialConfigured ? '已配置' : '未配置'}</FieldLabel><Input id={`credential-${server.id}`} type="password" autoComplete="off" value={credentials[server.id] ?? ''} onChange={(e) => setCredentials({...credentials,[server.id]:e.target.value})} /><div className="flex gap-2"><Button disabled={busy || !credentials[server.id]} onClick={() => void act(async () => { await agentFetch(`mcp-servers/${server.id}/credential`, 'PUT', {token:credentials[server.id]}); setCredentials((values) => ({...values,[server.id]:''})); })}>保存凭证</Button><Button disabled={busy} variant="outline" onClick={() => void act(() => agentFetch(`mcp-servers/${server.id}/credential`, 'DELETE'))}>清除凭证</Button></div></Field>)}</FieldGroup></CardContent></Card>}
  </div>;
}
