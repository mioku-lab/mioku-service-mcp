# mioku-service-mcp

Mioku 的 MCP（Model Context Protocol）客户端服务。连接外部 MCP 服务器，把它们的工具
暴露给插件（目前是 `mioku-plugin-agent`）。

## 用法

```ts
import { getService } from "mioku";
import { McpService } from "mioku-service-mcp";

const mcp = getService(ctx, McpService);
if (!mcp) {
  ctx.logger.warn("mcp 服务未加载，跳过 MCP 工具");
  return;
}

for (const tool of mcp.listTools()) {
  // tool.publicName 是模型可见名：mcp__<server>__<tool>
  // tool.parameters 是已归一化的 JSON Schema
}

const result = await mcp.callTool("mcp__fs__read_file", { path: "/tmp/a.txt" });
result.text;    // 文本结果（已按 maxResultChars 截断）
result.images;  // 已落盘的图片路径，base64 不回传
```

## 配置

`config/service/mcp/servers.json`，服务启动时自动创建。手工改动（包括让 agent 用
`write` / `edit` / `bash` 直接改这个文件）会被监听并热重载，300ms 防抖。
文件缺失或不是合法 JSON 时保留当前配置并打 warn，不会把所有连接一起清空。

WebUI 里分两处：

- **服务配置 → mcp**：本页（`config.md`）渲染的全局连接策略与限额，写入上面这个文件。
- **Agent → MCP**：服务器列表的增删改、连接状态、工具清单、日志与自检，走 `/api/mcp/*`。

服务的启停由消费方决定（agent 侧有「启用 MCP 工具」开关），服务本身没有总开关。

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoConnect` | `true` | 启动时自动连接已启用的服务器；关掉后需要手动连接，掉线也不再自动重连 |
| `reconnectDelayMs` | `2000` | 重连退避基数，指数增长，上限 30s |
| `maxConcurrency` | `4` | 同时进行的 `tools/call` 数量上限 |
| `maxTools` | `64` | 全部服务器的工具表条目上限 |
| `maxResultChars` | `20000` | 单个结果的文本截断长度 |
| `maxResultImages` | `4` | 单次结果最多落盘的图片张数 |
| `servers[]` | `[]` | 服务器列表，见下 |

单个服务器：

| 字段 | 说明 |
|---|---|
| `name` | 唯一定位名，同时是工具名前缀。`^[a-z0-9][a-z0-9_-]{0,23}$` |
| `enabled` | 新服务器默认 `false`，要显式连接一次 |
| `transport` | `stdio` / `http` / `sse` |
| `command` `args` `cwd` `env` | stdio 专用 |
| `url` `headers` | http / sse 专用 |
| `timeoutMs` `connectTimeoutMs` | 单次调用 / 连接尝试超时 |
| `maxTools` | 该服务器的工具表条目上限，0 表示跟随全局 |
| `toolFilter.allow` `toolFilter.deny` | 对服务器上的原始工具名做 glob 过滤 |
| `approval` | `never` / `always` / `auto`，由消费方（agent）读取并执行 |

`env` 与 `headers` 里的值是密钥：读接口一律返回 `****`，写接口收到 `****` 会保留旧值。

## 工具命名与预算

模型侧工具名固定为 `mcp__<server>__<tool>`，整体满足 `^[A-Za-z0-9_-]{1,64}$`
（OpenAI / Anthropic 的 function name 约束）。服务器名保证合法；工具名里的非法字符
替换为 `_`；超长或撞名时截断并追加 8 位稳定哈希。

`maxTools` 只决定谁拿到带 schema 的一等工具位。溢出的工具**不丢弃**：保留名字与描述进
`listAllTools()`（`catalogOnly: true`），消费方可以把它们写进系统提示词目录，并用
`callTool()` 按 `publicName` 调用。

## api

| 方法 | 说明 |
|---|---|
| `revision()` | 目录版本号，变化说明工具表需要重建 |
| `listTools()` | 一等工具（仅 ready 且启用的服务器） |
| `listAllTools()` | 全部工具，含 `catalogOnly` |
| `getTool(publicName)` | 按模型可见名取单个工具 |
| `listServers()` / `getServer(name)` | 连接状态 |
| `listServerConfigs()` / `getConfig()` | 带掩码的配置 |
| `upsertServer(input)` / `removeServer(name)` / `setServerEnabled(name, enabled)` | 增删改并热生效 |
| `updateConfig(patch)` | 改全局限额并立即协调连接（WebUI 全局设置走 `config.md`，不调用它） |
| `connect` / `disconnect` / `reconnect` / `reload` | 连接控制 |
| `probe(input)` | 自检：不落盘连一次，返回握手与工具清单 |
| `callTool(publicName, args, opts)` | 调用；`opts.imageDir` 指定图片落盘目录 |
| `recentLogs(server?, limit?)` | 每个服务器 100 条环形日志 |

## 依赖

`@modelcontextprotocol/client`（Apache-2.0）