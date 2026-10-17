let observedAbort = false;
export default {
  routes: [],
  onRegister(ctx) {
    ctx.registerExtension('llm.provider', {
      id: 'isolated-fixture', name: '隔离提供方',
      async listModels() { return [{id:'fixture',label:'Fixture',supportsTools:true}]; },
      async complete(request, options) {
        if (request.model === 'wait') {
          await new Promise((resolve) => { options.signal.addEventListener('abort', () => { observedAbort = true; resolve(); }, {once:true}); });
        }
        return {model:request.model,parts:[{type:'text',text:options.callId}],stopReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2},costMinor:0};
      },
      async aborted() { return observedAbort; },
    });
  },
};
