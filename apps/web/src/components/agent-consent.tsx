'use client';
import { useEffect,useState } from 'react';
import { agentFetch } from '@/components/agent-workspace';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Card,CardHeader,CardTitle,CardDescription,CardContent } from '@/components/ui/card';
export function AgentConsent() {
  const [request,setRequest] = useState<Record<string,string>>();const [info,setInfo] = useState<{client:{name:string};scopes:string[];redirectUri:string}>();const [error,setError] = useState('');const [busy,setBusy] = useState(false);
  useEffect(()=>{const params=Object.fromEntries(new URLSearchParams(window.location.search));setRequest(params);void agentFetch<typeof info>(`oauth/authorize?${new URLSearchParams(params)}`).then(setInfo).catch((cause:Error)=>setError(cause.message));},[]);
  async function approve(){setBusy(true);setError('');try{const result=await agentFetch<{redirectUri:string}>('oauth/authorize','POST',request);window.location.assign(result.redirectUri);}catch(cause){setError(cause instanceof Error?cause.message:'授权失败');setBusy(false);}}
  return <Card><CardHeader><CardTitle>授权 MCP 客户端</CardTitle><CardDescription>只授权当前用户拥有的权限，权限撤回后立即收紧。请核对客户端与回调域名。</CardDescription></CardHeader><CardContent><FieldError role="alert">{error}</FieldError>{info&&<><p>客户端：{info.client.name}</p><p>回调地址：{info.redirectUri}</p><ul>{info.scopes.map((scope)=><li key={scope}>{scope}</li>)}</ul><div className="flex gap-2"><Button disabled={busy} onClick={()=>void approve()}>同意授权</Button><Button variant="outline" onClick={()=>window.location.assign('/account/agent')}>拒绝并返回</Button></div></>}</CardContent></Card>;
}
