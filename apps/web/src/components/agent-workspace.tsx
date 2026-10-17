'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group';
import { Field, FieldDescription, FieldError, FieldGroup } from '@/components/ui/field';
import { Label as FieldLabel } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatDateTime } from '@/i18n/core';
import { useLocale, useTranslator } from '@/i18n/provider';
import { agentErrorFromBody, agentErrorText } from '@/lib/agent-errors';

type Run = { id: string; objective: string; status: string; model: string; steps: number; spendMinor: number; error?: string };
type Approval = { id: string; runId: string; capabilityId: string; args: unknown; expiresAt: string; run: { objective: string } };
type Server = { id: string; name: string; credentialConfigured: boolean };
type Step = { id: string; index: number; kind: string; toolName?: string; args?: unknown; result?: unknown; error?: string; costMinor: number };

/**
 * Transport helper for the Agent BFF.
 *
 * Failures carry the proxy's stable `code` when there is one; the caller turns
 * that into localized copy with `agentErrorText`.
 */
export async function agentFetch<T>(path: string, method = 'GET', body?: unknown, key?: string, idempotency?: string): Promise<T> {
  const res = await fetch(`/api/agent/${path}`, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-agent-key': key } : {}), ...(idempotency ? { 'idempotency-key': idempotency } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) throw agentErrorFromBody(data);
  return data as T;
}
export function JsonView({ value }: { value: unknown }) { return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>; }

export function AgentWorkspace({ runId, approvalsOnly = false }: { runId?: string; approvalsOnly?: boolean }) {
  const router = useRouter();
  const t = useTranslator();
  const locale = useLocale();
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
  const failText = useCallback(
    (cause: unknown) => agentErrorText(t, cause, t('common.operationFailed')),
    [t],
  );
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
    const tick = async () => { try { if (active) await refresh(); } catch (cause) { if (active) setError(failText(cause)); } finally { if (active && runId) timer = setTimeout(tick, 5000); } };
    void tick(); return () => { active = false; clearTimeout(timer); };
  }, [refresh, failText, runId]);
  async function act(action: () => Promise<unknown>, reload = true) { setBusy(true); setError(''); try { await action(); if(reload) await refresh(); } catch (cause) { setError(failText(cause)); } finally { setBusy(false); } }
  async function start(parentId?: string) {
    if (!key.trim()) throw new Error(t('agent.workspace.keyRequired'));
    const body = { objective, ...(model ? {model} : {}), autonomy, execution, ...(parentId ? {parentId} : {}) };
    const serialized = JSON.stringify(body);
    if (createIntent.current?.body !== serialized) createIntent.current = {body:serialized,id:crypto.randomUUID()};
    const result = await agentFetch<{run:Run}>('runs', 'POST', body, key.trim(), createIntent.current.id);
    createIntent.current = null; setObjective(''); router.push(`/account/agent/runs/${result.run.id}`);
  }
  return <div className="flex flex-col gap-6 p-6">
    <nav className="flex flex-wrap gap-3"><Link href="/account/agent">{t('agent.workspace.navTasks')}</Link><Link href="/account/agent/approvals">{t('agent.workspace.navApprovals')}</Link><Link href="/account/settings#security">{t('agent.workspace.navApiKeys')}</Link></nav>
    <h1>{approvalsOnly ? t('agent.workspace.titleApprovals') : run ? run.objective : t('agent.workspace.titleWorkspace')}</h1>
    <p>{status?.enabled ? t('agent.workspace.statusEnabled', { provider: status.provider?.name ?? t('agent.workspace.statusNotConfigured') }) : t('agent.workspace.statusDisabled')}</p>
    <FieldError role="alert">{error}</FieldError>
    {!approvalsOnly && <Card><CardHeader><CardTitle>{run ? t('agent.workspace.continueTitle') : t('agent.workspace.newTitle')}</CardTitle><CardDescription>{t('agent.workspace.formHint')}</CardDescription></CardHeader><CardContent>
      <form onSubmit={(event) => { event.preventDefault(); void act(() => start(runId)); }}><FieldGroup>
        <Field><FieldLabel htmlFor="agent-key">{t('agent.workspace.keyLabel')}</FieldLabel><Input id="agent-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /><FieldDescription>{t('agent.workspace.keyHint')}</FieldDescription></Field>
        <Field><FieldLabel htmlFor="agent-objective">{run ? t('agent.workspace.subObjectiveLabel') : t('agent.workspace.objectiveLabel')}</FieldLabel><InputGroup><InputGroupTextarea id="agent-objective" value={objective} maxLength={4000} onChange={(e) => setObjective(e.target.value)} /></InputGroup></Field>
        <Field><FieldLabel htmlFor="agent-model">{t('agent.workspace.modelLabel')}</FieldLabel><Input id="agent-model" list="agent-models" value={model} onChange={(e) => setModel(e.target.value)} /><datalist id="agent-models">{models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</datalist></Field>
        <Field><FieldLabel>{t('agent.workspace.executionLabel')}</FieldLabel><Select value={execution} onValueChange={(v) => v && setExecution(v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="request">{t('agent.workspace.executionRequest')}</SelectItem><SelectItem value="background">{t('agent.workspace.executionBackground')}</SelectItem></SelectGroup></SelectContent></Select></Field>
        <Field><FieldLabel>{t('agent.workspace.autonomyLabel')}</FieldLabel><Select value={autonomy} onValueChange={(v) => v && setAutonomy(v)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="read">{t('agent.workspace.autonomyRead')}</SelectItem><SelectItem value="propose">{t('agent.workspace.autonomyPropose')}</SelectItem><SelectItem value="act">{t('agent.workspace.autonomyAct')}</SelectItem></SelectGroup></SelectContent></Select></Field>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || !status?.enabled || !status.modelConfigured || !objective.trim()}>{run ? t('agent.workspace.createSubtask') : t('agent.workspace.start')}</Button>{run && <><Button type="button" variant="outline" disabled={busy || !key || !['QUEUED','RUNNING','WAITING_APPROVAL'].includes(run.status)} onClick={() => void act(() => agentFetch(`runs/${run.id}/resume`, 'POST', {execution}, key))}>{t('agent.workspace.resume')}</Button><Button type="button" variant="destructive" disabled={busy || !['QUEUED','RUNNING','WAITING_APPROVAL'].includes(run.status)} onClick={() => void act(() => agentFetch(`runs/${run.id}/cancel`, 'POST', {}))}>{t('agent.workspace.cancel')}</Button></>}</div>
      </FieldGroup></form>
    </CardContent></Card>}
    {run && <Card><CardHeader><CardTitle>{t('agent.workspace.replayTitle')} <Badge>{run.status}</Badge></CardTitle><CardDescription>{t('agent.workspace.replayMeta', { steps: run.steps, spend: run.spendMinor, model: run.model })}</CardDescription></CardHeader><CardContent><FieldError>{run.error}</FieldError>{steps.map((step) => <details key={step.id}><summary>{t('agent.workspace.replayStep', { index: step.index + 1, kind: step.kind, tool: step.toolName ?? '' })}</summary><JsonView value={step} /></details>)}{family.map((item) => <p key={item.id}><Link href={`/account/agent/runs/${item.id}`}>{item.objective}</Link> · {item.status}</p>)}</CardContent></Card>}
    {!runId && !approvalsOnly && <Card><CardHeader><CardTitle>{t('agent.workspace.runsTitle')}</CardTitle></CardHeader><CardContent>{!runs.length && <p>{t('agent.workspace.runsEmpty')}</p>}{runs.map((item) => <p key={item.id}><Link href={`/account/agent/runs/${item.id}`}>{item.objective}</Link> <Badge variant="secondary">{item.status}</Badge></p>)}{next && <Button variant="outline" disabled={busy} onClick={() => void act(async () => { const page = await agentFetch<{runs:Run[];nextCursor:string|null}>(`runs?cursor=${next}`); setRuns((rows) => [...rows, ...page.runs]); setNext(page.nextCursor); }, false)}>{t('agent.workspace.loadMoreRuns')}</Button>}</CardContent></Card>}
    <Card><CardHeader><CardTitle>{t('agent.workspace.approvalsTitle')}</CardTitle><CardDescription>{t('agent.workspace.approvalsHint')}</CardDescription></CardHeader><CardContent><FieldGroup><Field><FieldLabel htmlFor="approval-reason">{t('agent.workspace.approvalReason')}</FieldLabel><Input id="approval-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>{!approvals.length && <p>{t('agent.workspace.approvalsEmpty')}</p>}{approvals.filter((item) => !runId || item.runId === runId).map((item) => <Card key={item.id}><CardHeader><CardTitle>{item.capabilityId}</CardTitle><CardDescription>{item.run.objective} · {t('agent.workspace.expires', { date: formatDateTime(new Date(item.expiresAt), locale) })}</CardDescription></CardHeader><CardContent><JsonView value={item.args} /><div className="flex gap-2"><Button disabled={busy} onClick={() => void act(() => agentFetch(`approvals/${item.id}/decide`, 'POST', {approve:true,reason}))}>{t('agent.workspace.approve')}</Button><Button variant="outline" disabled={busy} onClick={() => void act(() => agentFetch(`approvals/${item.id}/decide`, 'POST', {approve:false,reason}))}>{t('agent.workspace.reject')}</Button><Link href={`/account/agent/runs/${item.runId}`}>{t('agent.workspace.viewRun')}</Link></div></CardContent></Card>)}{approvalNext && <Button variant="outline" disabled={busy} onClick={() => void act(async () => { const page = await agentFetch<{approvals:Approval[];nextCursor:string|null}>(`approvals?cursor=${approvalNext}`); setApprovals((rows) => [...rows,...page.approvals]); setApprovalNext(page.nextCursor); }, false)}>{t('agent.workspace.loadMoreApprovals')}</Button>}</FieldGroup></CardContent></Card>
    {!runId && !approvalsOnly && <Card><CardHeader><CardTitle>{t('agent.workspace.credentialsTitle')}</CardTitle><CardDescription>{t('agent.workspace.credentialsHint')}</CardDescription></CardHeader><CardContent><FieldGroup>{!servers.length && <p>{t('agent.workspace.credentialsEmpty')}</p>}{servers.map((server) => <Field key={server.id}><FieldLabel htmlFor={`credential-${server.id}`}>{server.name} · {server.credentialConfigured ? t('agent.workspace.configured') : t('agent.workspace.unconfigured')}</FieldLabel><Input id={`credential-${server.id}`} type="password" autoComplete="off" value={credentials[server.id] ?? ''} onChange={(e) => setCredentials({...credentials,[server.id]:e.target.value})} /><div className="flex gap-2"><Button disabled={busy || !credentials[server.id]} onClick={() => void act(async () => { await agentFetch(`mcp-servers/${server.id}/credential`, 'PUT', {token:credentials[server.id]}); setCredentials((values) => ({...values,[server.id]:''})); })}>{t('agent.workspace.saveCredential')}</Button><Button disabled={busy} variant="outline" onClick={() => void act(() => agentFetch(`mcp-servers/${server.id}/credential`, 'DELETE'))}>{t('agent.workspace.clearCredential')}</Button></div></Field>)}</FieldGroup></CardContent></Card>}
  </div>;
}
