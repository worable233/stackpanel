import { describe,it,expect } from 'vitest';
import { agentProxyTarget } from '../src/lib/agent-proxy-path';
describe('Agent BFF allowlist',()=>{
  it('only resolves explicit Agent endpoints',()=>{
    expect(agentProxyTarget('GET',['runs','run_123'])).toBe('/api/v1/agent/runs/run_123');
    expect(agentProxyTarget('PUT',['admin','model'])).toBe('/admin/agent/model');
    expect(agentProxyTarget('POST',['approvals','id','decide'])).toBe('/api/v1/agent/approvals/id/decide');
  });
  it('rejects traversal, encoded separators and arbitrary kernel proxies',()=>{
    for(const path of [['..','admin'],['%2e%2e','settings'],['admin','settings'],['runs','id/resume'],['runs','%2fid'],['oauth','token']]) expect(agentProxyTarget('GET',path)).toBeNull();
    expect(agentProxyTarget('TRACE',['status'])).toBeNull();
  });
});
