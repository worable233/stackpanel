import { describe,it,expect } from 'vitest';
import { rpcResult, agentHttp } from '../../src/agent/http.ts';
import { mcpDispatchProof,validMcpDispatch } from '../../src/agent/dispatch-proof.ts';
import type { FastifyRequest } from 'fastify';
describe('Agent transport boundaries',()=>{
  it('extracts the matching result from bounded SSE and ignores unrelated events',()=>{
    expect(rpcResult('data: {"id":"other","result":false}\n\ndata: {"jsonrpc":"2.0","id":"wanted","result":{"ok":true}}\n\n','wanted')).toEqual({ok:true});
    expect(()=>rpcResult('{"id":"a","error":{"message":"remote-secret"}}','a')).toThrow('agent.mcp_error');
    expect(()=>rpcResult('invalid','a')).toThrow('agent.mcp_protocol');
  });
  it('rejects local and credential-bearing endpoints before connecting',async()=>{
    for(const target of ['http://example.com/mcp','https://127.0.0.1/mcp','https://169.254.169.254/latest','https://secret@example.com']) await expect(agentHttp(target,{})).rejects.toMatchObject({code:'agent.network_forbidden'});
  });
  it('binds internal OAuth dispatch proof to request method, path, credential, IP and time',()=>{
    const request={method:'GET',url:'/api/v1/orders',ip:'192.0.2.1',headers:{authorization:'Bearer test','x-stackpanel-mcp-dispatch':''}};
    request.headers['x-stackpanel-mcp-dispatch']=mcpDispatchProof(request.method,request.url,request.headers.authorization,request.ip);
    expect(validMcpDispatch(request as unknown as FastifyRequest)).toBe(true);
    expect(validMcpDispatch({...request,url:'/admin/settings'} as unknown as FastifyRequest)).toBe(false);
    expect(validMcpDispatch({...request,ip:'192.0.2.2'} as unknown as FastifyRequest)).toBe(false);
    expect(validMcpDispatch({...request,headers:{...request.headers,'x-stackpanel-mcp-dispatch':mcpDispatchProof(request.method,request.url,request.headers.authorization,request.ip,Date.now()-6000)}} as unknown as FastifyRequest)).toBe(false);
  });
});
