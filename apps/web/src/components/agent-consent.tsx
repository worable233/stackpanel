'use client';
import { useEffect,useState } from 'react';
import { agentFetch } from '@/components/agent-workspace';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Card,CardHeader,CardTitle,CardDescription,CardContent } from '@/components/ui/card';
import { useTranslator } from '@/i18n/provider';
export function AgentConsent() {
  const t = useTranslator();
  const [request,setRequest] = useState<Record<string,string>>();const [info,setInfo] = useState<{client:{name:string};scopes:string[];redirectUri:string}>();const [error,setError] = useState('');const [busy,setBusy] = useState(false);
  useEffect(()=>{const params=Object.fromEntries(new URLSearchParams(window.location.search));setRequest(params);void agentFetch<typeof info>(`oauth/authorize?${new URLSearchParams(params)}`).then(setInfo).catch((cause:Error)=>setError(cause.message));},[]);
  async function approve(){setBusy(true);setError('');try{const result=await agentFetch<{redirectUri:string}>('oauth/authorize','POST',request);window.location.assign(result.redirectUri);}catch(cause){setError(cause instanceof Error?cause.message:t('agentConsent.failed'));setBusy(false);}}
  return <Card><CardHeader><CardTitle>{t('agentConsent.title')}</CardTitle><CardDescription>{t('agentConsent.description')}</CardDescription></CardHeader><CardContent><FieldError role="alert">{error}</FieldError>{info&&<><p>{t('agentConsent.client')}{info.client.name}</p><p>{t('agentConsent.redirectUri')}{info.redirectUri}</p><ul>{info.scopes.map((scope)=><li key={scope}>{scope}</li>)}</ul><div className="flex gap-2"><Button disabled={busy} onClick={()=>void approve()}>{t('agentConsent.approve')}</Button><Button variant="outline" onClick={()=>window.location.assign('/account/agent')}>{t('agentConsent.deny')}</Button></div></>}</CardContent></Card>;
}
