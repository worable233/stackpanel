'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { agentFetch, JsonView } from '@/components/agent-workspace';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InputGroup, InputGroupTextarea } from '@/components/ui/input-group';
import { Field, FieldDescription, FieldError, FieldGroup } from '@/components/ui/field';
import { Label as FieldLabel } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function ConfigEditor({title,description,base,initial,idRequired=true}:{title:string;description:string;base:string;initial:unknown;idRequired?:boolean}) {
  const [id,setId] = useState(''); const [json,setJson] = useState(JSON.stringify(initial,null,2));
  const [result,setResult] = useState<unknown>(); const [error,setError] = useState(''); const [busy,setBusy] = useState(false);
  async function send(method:string, suffix='') { setBusy(true);setError('');try { const path = `${base}${idRequired ? `/${encodeURIComponent(id)}` : ''}${suffix}`;setResult(await agentFetch(path,method,method==='PUT' ? JSON.parse(json) : undefined)); } catch(cause) {setError(cause instanceof Error ? cause.message : '操作失败');}finally{setBusy(false);} }
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent><FieldGroup>
    {idRequired && <Field><FieldLabel htmlFor={`${base}-id`}>标识 ID</FieldLabel><Input id={`${base}-id`} value={id} onChange={(e)=>setId(e.target.value)} /></Field>}
    <Field><FieldLabel htmlFor={`${base}-json`}>配置 JSON</FieldLabel><InputGroup><InputGroupTextarea id={`${base}-json`} rows={10} value={json} onChange={(e)=>setJson(e.target.value)} /></InputGroup></Field>
    <FieldError role="alert">{error}</FieldError><div className="flex flex-wrap gap-2"><Button disabled={busy || (idRequired && !id)} onClick={()=>void send('PUT')}>保存配置</Button><Button variant="outline" disabled={busy || (idRequired && !id && base==='admin/profiles')} onClick={()=>void send('GET')}>读取配置</Button>{base==='admin/mcp-servers' && <Button variant="outline" disabled={busy || !id} onClick={()=>void send('POST','/discover')}>探测远端工具（当前管理员凭证）</Button>}</div>
    {result !== undefined && <JsonView value={result} />}
  </FieldGroup></CardContent></Card>;
}
export function AgentAdmin() {
  const [enabled,setEnabled] = useState(false);const [model,setModel] = useState({baseUrl:'',model:'',apiKeyConfigured:false});
  const [secret,setSecret] = useState('');const [error,setError] = useState('');const [busy,setBusy] = useState(false);const [runs,setRuns] = useState<unknown[]>([]);const [cursor,setCursor] = useState<string|null>(null);
  useEffect(()=>{void Promise.all([agentFetch<{enabled:boolean}>('status'),agentFetch<typeof model>('admin/model'),agentFetch<{runs:unknown[];nextCursor:string|null}>('admin/runs')]).then(([status,config,list])=>{setEnabled(status.enabled);setModel({...config,baseUrl:config.baseUrl??'',model:config.model??''});setRuns(list.runs);setCursor(list.nextCursor);}).catch((cause:Error)=>setError(cause.message));},[]);
  async function act(action:()=>Promise<unknown>) {setBusy(true);setError('');try{await action();}catch(cause){setError(cause instanceof Error?cause.message:'操作失败');}finally{setBusy(false);}}
  return <div className="flex flex-col gap-6 p-6"><h1>Agent 管理</h1><Link href="/account/agent">进入我的 Agent 工作区</Link><FieldError role="alert">{error}</FieldError>
    <Card><CardHeader><CardTitle>站点开关与模型供给</CardTitle><CardDescription>模型费用由站长承担。扩展点提供方优先，未安装时使用下列 OpenAI 兼容接口。</CardDescription></CardHeader><CardContent><FieldGroup>
      <Field><FieldLabel>本站 Agent：{enabled?'已开启':'已关闭'}</FieldLabel><Button disabled={busy} variant="outline" onClick={()=>void act(async()=>{await agentFetch('admin/enabled','PUT',{enabled:!enabled});setEnabled(!enabled);})}>{enabled?'关闭 Agent':'开启 Agent'}</Button></Field>
      <Field><FieldLabel htmlFor="model-url">模型接口地址</FieldLabel><Input id="model-url" type="url" value={model.baseUrl} onChange={(e)=>setModel({...model,baseUrl:e.target.value})} /></Field>
      <Field><FieldLabel htmlFor="model-id">默认模型名称</FieldLabel><Input id="model-id" value={model.model} onChange={(e)=>setModel({...model,model:e.target.value})} /></Field>
      <Field><FieldLabel htmlFor="model-secret">模型密钥</FieldLabel><Input id="model-secret" type="password" autoComplete="off" value={secret} onChange={(e)=>setSecret(e.target.value)} /><FieldDescription>{model.apiKeyConfigured?'已保存，留空保持原密钥':'未配置'}；密钥不回显。</FieldDescription></Field>
      <div className="flex gap-2"><Button disabled={busy} onClick={()=>void act(async()=>{setModel(await agentFetch('admin/model','PUT',{baseUrl:model.baseUrl,model:model.model,...(secret?{apiKey:secret}:{})}));setSecret('');})}>保存模型配置</Button><Button disabled={busy} variant="outline" onClick={()=>void act(async()=>{await agentFetch('admin/model','DELETE');setModel({baseUrl:'',model:'',apiKeyConfigured:false});setSecret('');})}>清除模型配置</Button></div>
    </FieldGroup></CardContent></Card>
    <ConfigEditor title="Key 执行策略上限" description="输入平台 API Key 的 tokenId。只设置自主度和额度上限，不增加任何权限；金额单位为最小货币单位。预算计价未知时拒绝执行。" base="admin/profiles" initial={{autonomy:'read',maxSteps:50,maxRunSeconds:600,budgetMinor:null,dailyBudgetMinor:null,dailySteps:500,allowedModels:[],approvalNotify:null}} />
    <ConfigEditor title="外部 MCP 服务审核" description="仅支持公网 HTTPS。工具清单须经人工审核后保存；默认为高风险写。保存会使旧工具版本失效。凭证由用户在工作区配置；权限通过权限模板授予 mcp.external.ID。" base="admin/mcp-servers" initial={{name:'外部服务',url:'https://example.com/mcp',enabled:false,tools:[{name:'example',description:'工具说明',inputSchema:{type:'object',properties:{},additionalProperties:false},readOnly:false,destructive:true}]}} />
    <ConfigEditor title="OAuth 客户端" description="固定客户端 ID 和精确回调清单。要求配置 AGENT_PUBLIC_ORIGIN、AGENT_WEB_ORIGIN；使用 S256 PKCE、一次性授权码和轮换刷新令牌。禁用会撤销其令牌。" base="admin/oauth-clients" initial={{name:'MCP 客户端',redirectUris:['https://example.com/callback'],enabled:false}} />
    <ConfigEditor title="隔离脚本动作" description="Docker 必须可用且预先拉取固定摘要镜像。禁网、非 root、只读文件系统、限制 CPU/内存/进程数。参数仅以 stdin JSON 传入；argv 仅由管理员指定。先通过权限模板授予 agent.action.ID。所有 Agent 调用逐次确认。" base="admin/actions" initial={{name:'隔离动作',image:`example/script@sha256:${'0'.repeat(64)}`,argv:['/app/run'],enabled:false,timeoutSeconds:30,inputSchema:{type:'object'}}} />
    <Card><CardHeader><CardTitle>全站任务审计</CardTitle></CardHeader><CardContent><JsonView value={runs} />{cursor && <Button disabled={busy} variant="outline" onClick={()=>void act(async()=>{const list=await agentFetch<{runs:unknown[];nextCursor:string|null}>(`admin/runs?cursor=${cursor}`);setRuns([...runs,...list.runs]);setCursor(list.nextCursor);})}>加载更多</Button>}</CardContent></Card>
  </div>;
}
