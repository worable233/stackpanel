import { AgentWorkspace } from '@/components/agent-workspace';
export default async function Page({params}:{params:Promise<{id:string}>}) { return <AgentWorkspace runId={(await params).id} />; }
