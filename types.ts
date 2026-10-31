export type McpTransportKind = "stdio" | "http" | "sse";

/**
 * 调用审批策略，由消费方（agent）读取并执行：
 * `always` 要用户批准；`auto` 不批准但推送执行告知；`never` 完全静默。
 */
export type McpApprovalMode = "never" | "always" | "auto";

export type McpServerState = "idle" | "connecting" | "ready" | "error";

export interface McpToolFilter {
  /** 命中的原始工具名放行；为空表示不按白名单过滤 */
  allow?: string[];
  /** 命中的原始工具名剔除 */
  deny?: string[];
}

export interface McpServerConfig {
  /** 唯一定位名，同时是工具名前缀 */
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  /** 仅 WebUI 展示 */
  description?: string;

  // stdio
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;

  // http / sse
  url?: string;
  headers?: Record<string, string>;

  /** 进模型工具表的数量上限；0 表示跟随全局 */
  maxTools?: number;
  /** 单次 tools/call 超时，毫秒 */
  timeoutMs: number;
  /** 连接尝试超时，毫秒 */
  connectTimeoutMs: number;
  toolFilter?: McpToolFilter;
  /** 调用前是否需要聊天内审批 */
  approval: McpApprovalMode;
}

export interface McpConfig {
  /** 服务启动时自动连接已启用的服务器；关掉后需要手动连接 */
  autoConnect: boolean;
  /** 重连基础退避，毫秒 */
  reconnectDelayMs: number;
  /** 同一时刻的 tools/call 并发上限 */
  maxConcurrency: number;
  /** 全部服务器的工具数上限 */
  maxTools: number;
  /** 单个工具结果的文本截断长度 */
  maxResultChars: number;
  /** 单次结果最多落盘的图片张数 */
  maxResultImages: number;
  servers: McpServerConfig[];
}

export interface McpServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

export interface McpServerStatus {
  name: string;
  transport: McpTransportKind;
  enabled: boolean;
  approval: McpApprovalMode;
  description: string;
  state: McpServerState;
  /** 展示用：stdio 是命令行，http/sse 是地址 */
  target: string;
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
  capabilities: McpServerCapabilities;
  toolCount: number;
  catalogOnlyCount: number;
  lastError?: string;
  lastConnectedAt?: number;
  reconnectAttempts: number;
}

export interface McpToolSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface McpToolInfo {
  /** 模型看到的工具名 */
  publicName: string;
  /** 服务器上的原始名 */
  tool: string;
  server: string;
  description: string;
  parameters: McpToolSchema;
  /** 因数量预算没进工具表，只在系统提示词目录里出现 */
  catalogOnly: boolean;
}

export interface McpToolImage {
  path: string;
  mimeType: string;
  bytes: number;
}

export interface McpToolResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  images: McpToolImage[];
  isError: boolean;
  durationMs: number;
  truncated: boolean;
}

export interface McpProbeTool {
  name: string;
  description: string;
}

export interface McpProbeResult {
  ok: boolean;
  durationMs: number;
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  capabilities?: McpServerCapabilities;
  instructions?: string;
  tools: McpProbeTool[];
  error?: string;
}

export interface McpLogEntry {
  at: number;
  server: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** 写入接口的入参：密钥字段回传 `****` 表示保留旧值 */
export interface McpServerInput extends Partial<Omit<McpServerConfig, "name">> {
  name: string;
}

/** MCP 服务暴露给插件的接口 */
export interface McpServiceApi {
  /** 目录版本号；变化说明工具表需要重建 */
  revision(): number;
  /** 当前可用的工具（仅 ready 且启用的服务器） */
  listTools(): McpToolInfo[];
  /** 目录里的全部工具，含 catalogOnly */
  listAllTools(): McpToolInfo[];
  /** 按模型可见名取单个工具 */
  getTool(publicName: string): McpToolInfo | undefined;

  listServers(): McpServerStatus[];
  getServer(name: string): McpServerStatus | undefined;
  /** 带掩码的配置，给 WebUI 用 */
  listServerConfigs(): McpServerConfig[];
  getConfig(): McpConfig;

  upsertServer(input: McpServerInput): Promise<McpServerStatus | { error: string }>;
  removeServer(name: string): Promise<boolean>;
  setServerEnabled(name: string, enabled: boolean): Promise<McpServerStatus | { error: string }>;
  updateConfig(patch: Partial<Omit<McpConfig, "servers">>): Promise<McpConfig>;

  connect(name: string): Promise<McpServerStatus | { error: string }>;
  disconnect(name: string): Promise<McpServerStatus | { error: string }>;
  reconnect(name: string): Promise<McpServerStatus | { error: string }>;
  /** 重读配置并协调连接 */
  reload(): Promise<void>;

  /** 自检：不落盘，连一次并返回握手与工具清单 */
  probe(input: McpServerInput): Promise<McpProbeResult>;

  /** 按模型可见名调用工具 */
  callTool(
    publicName: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number; imageDir?: string },
  ): Promise<McpToolResult>;

  recentLogs(server?: string, limit?: number): McpLogEntry[];
}
