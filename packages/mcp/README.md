# @stackpanel/mcp

StackPanel 开放平台的 MCP（Model Context Protocol）stdio 客户端。

工具清单由平台能力清单（capability registry）派生，凭证 scope 决定可见工具集：
只读工具默认可用；写 / 下单 / 扣费 / 销毁等变更类工具需要凭证显式授予 `mcp.write`。

## 用法

```bash
# 远端一次配置（平台 API 基址 + 平台凭证 sp_…）
STACKPANEL_API_URL=https://panel.example.com \
STACKPANEL_API_TOKEN=sp_xxx \
npx @stackpanel/mcp
```

或显式传参：

```bash
npx @stackpanel/mcp --url https://panel.example.com --token sp_xxx
```

在支持 MCP 的客户端（Claude Desktop / Cursor / 等）中注册为 stdio server：

```json
{
  "mcpServers": {
    "stackpanel": {
      "command": "npx",
      "args": ["-y", "@stackpanel/mcp"],
      "env": {
        "STACKPANEL_API_URL": "https://panel.example.com",
        "STACKPANEL_API_TOKEN": "sp_xxx"
      }
    }
  }
}
```

## 传输

stdio 桥接器把标准输入的换行分隔 JSON-RPC 消息转发到服务端 Streamable HTTP 的
`POST /mcp`（携带同一平台凭证），再把响应写回标准输出。协议逻辑全部在服务端
（`apps/api/src/mcp`），本包只做传输适配，不复制任何领域实现。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `STACKPANEL_API_URL` / `STACKPANEL_API_BASE_URL` | 平台 API 基址（不含 `/mcp` 亦可） |
| `STACKPANEL_API_TOKEN` | 平台 API 凭证（`sp_…`） |

## 开发

```bash
pnpm --filter @stackpanel/mcp test
pnpm --filter @stackpanel/mcp build
```
