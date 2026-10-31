import { Client } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import type { Stream } from "node:stream";
import {
  CLIENT_NAME,
  CLIENT_VERSION,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
} from "../constants";
import { settleWithin, withTimeout } from "./async";
import { describeTarget, createTransport } from "./transport";
import type { RawTool } from "./catalog";
import type { McpLogs } from "./logs";
import type {
  McpServerCapabilities,
  McpServerConfig,
  McpServerState,
  McpServerStatus,
} from "../types";

export interface ConnectionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface McpConnectionOptions {
  config: McpServerConfig;
  logs: McpLogs;
  logger: ConnectionLogger;
  /** 状态或工具目录变化时通知服务 */
  onChange(): void;
  /** 掉线后是否允许自动重连 */
  autoReconnect(): boolean;
}

const CLOSE_TIMEOUT_MS = 1500;

const EMPTY_CAPABILITIES: McpServerCapabilities = {
  tools: false,
  resources: false,
  prompts: false,
};

export interface ProbeOutcome {
  ok: boolean;
  error?: string;
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  capabilities?: McpServerCapabilities;
  instructions?: string;
  tools: RawTool[];
}

function safeClose(transport: Transport | null): Promise<void> {
  if (!transport) return Promise.resolve();
  try {
    return Promise.resolve(transport.close());
  } catch (error) {
    return Promise.reject(error);
  }
}

/** 一个服务器的连接：状态机、重连退避、工具目录缓存 */
export class McpConnection {
  private cfg: McpServerConfig;
  private readonly logs: McpLogs;
  private readonly logger: ConnectionLogger;
  private readonly onChange: () => void;
  private readonly autoReconnect: () => boolean;

  private client: Client | null = null;
  private transport: Transport | null = null;

  private state: McpServerState = "idle";
  private raws: RawTool[] = [];
  private info: { name: string; version: string } | undefined;
  private capabilities: McpServerCapabilities = EMPTY_CAPABILITIES;
  private protocolVersion: string | undefined;
  private instructions: string | undefined;
  private lastError: string | undefined;
  private lastConnectedAt: number | undefined;
  private attempts = 0;
  private reconnectBaseMs = 2000;

  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 每次连接自增，用来作废上一轮的异步回调 */
  private generation = 0;
  private closing = false;

  constructor(options: McpConnectionOptions) {
    this.cfg = options.config;
    this.logs = options.logs;
    this.logger = options.logger;
    this.onChange = options.onChange;
    this.autoReconnect = options.autoReconnect;
  }

  get name(): string {
    return this.cfg.name;
  }

  get config(): McpServerConfig {
    return this.cfg;
  }

  get isReady(): boolean {
    return this.state === "ready" && this.client !== null;
  }

  get tools(): RawTool[] {
    return this.raws;
  }

  get serverInstructions(): string | undefined {
    return this.instructions;
  }

  /** 传输方式、目标或凭据变化时必须重连 */
  requiresReconnect(next: McpServerConfig): boolean {
    const scalarKeys: Array<keyof McpServerConfig> = [
      "transport",
      "command",
      "url",
      "cwd",
    ];
    for (const key of scalarKeys) {
      if (next[key] !== this.cfg[key]) return true;
    }
    const listKeys: Array<keyof McpServerConfig> = ["args"];
    for (const key of listKeys) {
      if (JSON.stringify(next[key] ?? []) !== JSON.stringify(this.cfg[key] ?? [])) {
        return true;
      }
    }
    const mapKeys: Array<keyof McpServerConfig> = ["env", "headers"];
    for (const key of mapKeys) {
      if (JSON.stringify(next[key] ?? {}) !== JSON.stringify(this.cfg[key] ?? {})) {
        return true;
      }
    }
    return false;
  }

  applyConfig(next: McpServerConfig): void {
    this.cfg = next;
  }

  setReconnectBase(ms: number): void {
    this.reconnectBaseMs = Math.max(200, ms);
  }

  status(): McpServerStatus {
    return {
      name: this.cfg.name,
      transport: this.cfg.transport,
      enabled: this.cfg.enabled,
      approval: this.cfg.approval,
      description: this.cfg.description ?? "",
      state: this.state,
      target: describeTarget(this.cfg),
      ...(this.info ? { serverInfo: this.info } : {}),
      ...(this.protocolVersion ? { protocolVersion: this.protocolVersion } : {}),
      capabilities: this.capabilities,
      toolCount: this.raws.length,
      catalogOnlyCount: 0,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastConnectedAt ? { lastConnectedAt: this.lastConnectedAt } : {}),
      reconnectAttempts: this.attempts,
    };
  }

  private setState(next: McpServerState): void {
    if (this.state === next) return;
    this.state = next;
    this.onChange();
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.logs.push(this.cfg.name, level, message);
    const line = `[mcp] ${this.cfg.name}: ${message}`;
    if (level === "error") this.logger.error(line);
    else if (level === "warn") this.logger.warn(line);
    else if (level === "info") this.logger.info(line);
    else this.logger.debug(line);
  }

  private attachStderr(stream: Stream | null): void {
    if (!stream) return;
    const readable = stream as Stream & {
      setEncoding?: (encoding: string) => void;
      on(event: "data", listener: (chunk: string | Buffer) => void): void;
    };
    readable.setEncoding?.("utf8");
    readable.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) this.log("debug", `stderr: ${text}`);
    });
  }

  async connect(): Promise<void> {
    if (this.state === "connecting" || this.state === "ready") return;
    this.clearReconnect();
    this.closing = false;
    const gen = ++this.generation;
    this.setState("connecting");
    this.lastError = undefined;

    try {
      const created = createTransport(this.cfg);
      this.transport = created.transport;
      this.attachStderr(created.stderr);

      this.transport.onclose = () => this.handleDrop(gen, "连接已关闭");
      this.transport.onerror = (error: Error) =>
        this.handleDrop(gen, String(error?.message ?? error));

      const client = new Client(
        { name: CLIENT_NAME, version: CLIENT_VERSION },
        {
          listChanged: {
            tools: {
              autoRefresh: false,
              onChanged: () => {
                if (gen !== this.generation) return;
                this.log("info", "服务器通知工具列表变化，重新拉取");
                void this.refreshTools(gen);
              },
            },
          },
        },
      );

      await withTimeout(
        client.connect(this.transport),
        this.cfg.connectTimeoutMs,
        `连接超时（${this.cfg.connectTimeoutMs}ms）`,
      );

      if (gen !== this.generation) {
        await settleWithin(client.close(), CLOSE_TIMEOUT_MS);
        return;
      }

      this.client = client;
      const info = client.getServerVersion();
      this.info = info ? { name: info.name, version: info.version } : undefined;
      const caps = (client.getServerCapabilities() ?? {}) as Record<string, unknown>;
      this.capabilities = {
        tools: Boolean(caps.tools),
        resources: Boolean(caps.resources),
        prompts: Boolean(caps.prompts),
      };
      this.protocolVersion = client.getNegotiatedProtocolVersion();
      this.instructions = client.getInstructions();

      this.lastConnectedAt = Date.now();
      this.attempts = 0;
      this.setState("ready");
      const label = this.info ? `${this.info.name}@${this.info.version}` : "未知服务器";
      this.log("info", `已连接 ${label}，协议 ${this.protocolVersion ?? "?"}`);
      await this.refreshTools(gen);
    } catch (error) {
      if (gen !== this.generation) return;
      this.fail(String((error as Error)?.message ?? error));
      await this.teardown();
      this.scheduleReconnect();
    }
  }

  private async refreshTools(gen: number): Promise<void> {
    const client = this.client;
    if (!client || gen !== this.generation) return;
    try {
      const listed = await client.listTools();
      if (gen !== this.generation) return;
      const tools = (listed?.tools ?? []) as RawTool[];
      this.raws = tools;
      this.log("info", `工具目录已刷新：${tools.length} 个`);
      this.onChange();
    } catch (error) {
      if (gen !== this.generation) return;
      this.log("warn", `拉取工具列表失败：${String(error)}`);
      this.raws = [];
      this.onChange();
    }
  }

  private handleDrop(gen: number, reason: string): void {
    if (gen !== this.generation || this.closing) return;
    this.fail(reason);
    void this.teardown().then(() => this.scheduleReconnect());
  }

  private fail(reason: string): void {
    this.raws = [];
    this.lastError = reason;
    this.setState("error");
    this.log("error", reason);
  }

  private scheduleReconnect(): void {
    if (this.closing || !this.cfg.enabled || !this.autoReconnect()) return;
    if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
      this.log("error", `重连 ${this.attempts} 次仍失败，停在错误态等待手动重连`);
      return;
    }
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** this.attempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.attempts += 1;
    this.log("warn", `${delay}ms 后重连（第 ${this.attempts} 次）`);
    this.clearReconnect();
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined;
        if (this.closing) return;
        void this.connect();
      },
      delay + Math.floor(Math.random() * 250),
    );
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /** 断开客户端并清掉传输；不触发重连 */
  private async teardown(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    if (client) await settleWithin(client.close(), CLOSE_TIMEOUT_MS);
    await settleWithin(safeClose(transport), CLOSE_TIMEOUT_MS);
  }

  /** 主动断开：作废当前 generation 并强制关停 */
  async close(): Promise<void> {
    this.closing = true;
    this.generation += 1;
    this.clearReconnect();
    await this.teardown();
    this.raws = [];
    this.attempts = 0;
    this.setState("idle");
    this.log("info", "已断开");
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown> {
    const client = this.client;
    if (!client || this.state !== "ready") {
      throw new Error(`服务器 "${this.cfg.name}" 未连接`);
    }
    const timeoutMs =
      options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : this.cfg.timeoutMs;
    return client.callTool(
      { name: tool, arguments: args },
      {
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
  }

  /** 自检：连一次、读目录、立刻断开 */
  async probe(): Promise<ProbeOutcome> {
    const created = createTransport(this.cfg);
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    try {
      await withTimeout(
        client.connect(created.transport),
        this.cfg.connectTimeoutMs,
        `连接超时（${this.cfg.connectTimeoutMs}ms）`,
      );
      const info = client.getServerVersion();
      const caps = (client.getServerCapabilities() ?? {}) as Record<string, unknown>;
      const listed = await withTimeout(
        client.listTools(),
        this.cfg.connectTimeoutMs,
        `拉取工具列表超时（${this.cfg.connectTimeoutMs}ms）`,
      );
      const instructions = client.getInstructions();
      return {
        ok: true,
        protocolVersion: client.getNegotiatedProtocolVersion(),
        ...(info ? { serverInfo: { name: info.name, version: info.version } } : {}),
        capabilities: {
          tools: Boolean(caps.tools),
          resources: Boolean(caps.resources),
          prompts: Boolean(caps.prompts),
        },
        ...(instructions ? { instructions } : {}),
        tools: (listed?.tools ?? []) as RawTool[],
      };
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? error), tools: [] };
    } finally {
      await settleWithin(client.close(), CLOSE_TIMEOUT_MS);
      await settleWithin(safeClose(created.transport), CLOSE_TIMEOUT_MS);
    }
  }
}
