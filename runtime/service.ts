import * as fs from "node:fs";
import * as path from "node:path";
import { updateServiceConfig } from "mioku";
import { HARD_LIMITS, SERVICE_NAME } from "../constants";
import {
  MCP_DEFAULTS,
  maskServerSecrets,
  normalizeConfig,
  normalizeServer,
} from "../config";
import { McpConnection } from "./connection";
import { McpLogs } from "./logs";
import { Semaphore } from "./async";
import { buildCatalog, describeRawTools } from "./catalog";
import { normalizeCallToolResult } from "./result";
import type { ConnectionLogger } from "./connection";
import type {
  McpConfig,
  McpLogEntry,
  McpProbeResult,
  McpServerConfig,
  McpServerInput,
  McpServerStatus,
  McpServiceApi,
  McpToolInfo,
  McpToolResult,
} from "../types";

const CONFIG_NAME = "servers";
const WATCH_DEBOUNCE_MS = 300;

export interface McpRuntimeOptions {
  logger: ConnectionLogger;
  /** 图片默认落盘目录：`data/mcp/images` */
  dataDir: string;
  /** 配置目录：`config/service/mcp` */
  configDir: string;
}

export interface McpRuntime {
  api: McpServiceApi;
  /** 读盘、协调连接、开始监听配置目录 */
  start(): Promise<void>;
  /** 卸载：停掉监听、断开全部连接 */
  dispose(): Promise<void>;
}

function isErrorResult(value: unknown): value is { error: string } {
  return Boolean(value) && typeof value === "object" && "error" in (value as object);
}

export function createMcpRuntime(options: McpRuntimeOptions): McpRuntime {
  const { logger, dataDir, configDir } = options;
  const logs = new McpLogs();
  const connections = new Map<string, McpConnection>();
  const concurrency = new Semaphore(MCP_DEFAULTS.maxConcurrency);
  const configPath = path.join(configDir, `${CONFIG_NAME}.json`);

  let config: McpConfig = { ...MCP_DEFAULTS };
  let revision = 0;
  let catalog: McpToolInfo[] = [];
  let catalogDirty = true;
  let watcher: fs.FSWatcher | undefined;
  let watchTimer: ReturnType<typeof setTimeout> | undefined;
  /** 最近一次由本进程写入或已应用的配置文本，用来识别自己的写入 */
  let lastAppliedText = "";
  let probing = false;
  let disposed = false;

  function bump(): void {
    revision += 1;
    catalogDirty = true;
  }

  /** 目录只在被读取时重算，避免每次连接抖动都做一遍归一化 */
  function currentCatalog(): McpToolInfo[] {
    if (!catalogDirty) return catalog;
    const inputs = [...connections.values()]
      .filter((conn) => conn.isReady && conn.config.enabled)
      .map((conn) => ({ server: conn.config, raw: conn.tools }));
    catalog = buildCatalog(inputs, config.maxTools);
    catalogDirty = false;
    return catalog;
  }

  function statusOf(conn: McpConnection): McpServerStatus {
    const status = conn.status();
    const tools = currentCatalog().filter((tool) => tool.server === conn.name);
    return {
      ...status,
      toolCount: tools.length,
      catalogOnlyCount: tools.filter((tool) => tool.catalogOnly).length,
    };
  }

  async function persist(): Promise<void> {
    lastAppliedText = JSON.stringify(config, null, 2);
    await updateServiceConfig(
      SERVICE_NAME,
      CONFIG_NAME,
      config as unknown as Record<string, unknown>,
    );
  }

  function applyGlobals(): void {
    concurrency.setLimit(config.maxConcurrency);
    for (const conn of connections.values()) {
      conn.setReconnectBase(config.reconnectDelayMs);
    }
  }

  function shouldAutoConnect(server: McpServerConfig): boolean {
    return config.autoConnect && server.enabled;
  }

  /** 让连接状态与当前配置一致 */
  async function reconcile(): Promise<void> {
    applyGlobals();
    const wanted = new Map(config.servers.map((server) => [server.name, server]));

    for (const [name, conn] of [...connections]) {
      const next = wanted.get(name);
      if (!next) {
        await conn.close();
        connections.delete(name);
        continue;
      }
      const reconnectNeeded = conn.requiresReconnect(next);
      conn.applyConfig(next);
      if (!next.enabled) {
        if (conn.isReady || reconnectNeeded) await conn.close();
        continue;
      }
      if (reconnectNeeded) {
        await conn.close();
        if (shouldAutoConnect(next)) await conn.connect();
        continue;
      }
      if (!conn.isReady && shouldAutoConnect(next)) {
        await conn.connect();
      }
    }

    for (const server of config.servers) {
      if (connections.has(server.name)) continue;
      const conn = new McpConnection({
        config: server,
        logs,
        logger,
        onChange: () => bump(),
        autoReconnect: () => config.autoConnect,
      });
      conn.setReconnectBase(config.reconnectDelayMs);
      connections.set(server.name, conn);
      if (shouldAutoConnect(server)) await conn.connect();
    }

    bump();
  }

  function readConfigText(): string | null {
    try {
      return fs.readFileSync(configPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * 读盘。文件缺失或不是合法 JSON 时返回 false 并保留当前配置——
   * 手改配置写坏一个字符不该把所有连接一起清空。
   */
  async function loadFromDisk(): Promise<boolean> {
    const text = readConfigText();
    if (text === null) {
      logger.warn(`[mcp] 配置文件不存在（${configPath}），保留当前配置`);
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      logger.warn(`[mcp] 配置文件不是合法 JSON，保留当前配置：${String(error)}`);
      return false;
    }
    config = normalizeConfig(parsed);
    lastAppliedText = text;
    return true;
  }

  function scheduleExternalReload(): void {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = undefined;
      if (disposed) return;
      // 内容与上次写入/应用的一致 = 自己的写入，跳过
      const text = readConfigText();
      if (text !== null && text === lastAppliedText) return;
      void loadFromDisk()
        .then((applied) => (applied ? reconcile() : undefined))
        .then(() => logger.info("[mcp] 配置已从磁盘热重载"))
        .catch((error) => logger.warn(`[mcp] 热重载失败：${String(error)}`));
    }, WATCH_DEBOUNCE_MS);
  }

  function startWatching(): void {
    try {
      // 监听目录而不是文件：编辑器与部分写盘方式是 rename，单文件 watch 会失效
      watcher = fs.watch(configDir, { encoding: "utf-8" }, () => {
        if (disposed) return;
        scheduleExternalReload();
      });
    } catch (error) {
      logger.warn(`[mcp] 无法监听配置目录 ${configDir}：${String(error)}`);
    }
  }

  const api: McpServiceApi = {
    revision: () => revision,

    listTools: () => currentCatalog().filter((tool) => !tool.catalogOnly),

    listAllTools: () => [...currentCatalog()],

    getTool: (publicName) =>
      currentCatalog().find((tool) => tool.publicName === publicName),

    listServers: () =>
      [...connections.values()]
        .map((conn) => statusOf(conn))
        .sort((a, b) => a.name.localeCompare(b.name)),

    getServer: (name) => {
      const conn = connections.get(name);
      return conn ? statusOf(conn) : undefined;
    },

    listServerConfigs: () => config.servers.map((server) => maskServerSecrets(server)),

    getConfig: () => ({
      ...config,
      servers: config.servers.map((server) => maskServerSecrets(server)),
    }),

    async upsertServer(input: McpServerInput) {
      const prev = config.servers.find((server) => server.name === input.name);
      const normalized = normalizeServer(input, prev);
      if (isErrorResult(normalized)) return normalized;

      const index = config.servers.findIndex((server) => server.name === normalized.name);
      if (index >= 0) config.servers[index] = normalized;
      else config.servers.push(normalized);

      await persist();
      await reconcile();
      return api.getServer(normalized.name) ?? { error: "服务器未注册" };
    },

    async removeServer(name: string) {
      const index = config.servers.findIndex((server) => server.name === name);
      if (index < 0) return false;
      config.servers.splice(index, 1);
      const conn = connections.get(name);
      if (conn) {
        await conn.close();
        connections.delete(name);
      }
      logs.clear(name);
      await persist();
      bump();
      return true;
    },

    async setServerEnabled(name: string, enabled: boolean) {
      const server = config.servers.find((item) => item.name === name);
      if (!server) return { error: `服务器 "${name}" 不存在` };
      server.enabled = enabled;
      await persist();
      await reconcile();
      return api.getServer(name) ?? { error: "服务器未注册" };
    },

    async updateConfig(patch) {
      const next = normalizeConfig({ ...config, ...patch, servers: [] });
      config = { ...next, servers: config.servers };
      await persist();
      await reconcile();
      return api.getConfig();
    },

    async connect(name: string) {
      const conn = connections.get(name);
      if (!conn) return { error: `服务器 "${name}" 不存在` };
      await conn.connect();
      return statusOf(conn);
    },

    async disconnect(name: string) {
      const conn = connections.get(name);
      if (!conn) return { error: `服务器 "${name}" 不存在` };
      await conn.close();
      return statusOf(conn);
    },

    async reconnect(name: string) {
      const conn = connections.get(name);
      if (!conn) return { error: `服务器 "${name}" 不存在` };
      await conn.close();
      await conn.connect();
      return statusOf(conn);
    },

    async reload() {
      if (!(await loadFromDisk())) return;
      await reconcile();
      logger.info(`[mcp] 配置已重载：${config.servers.length} 个服务器`);
    },

    async probe(input: McpServerInput): Promise<McpProbeResult> {
      const started = Date.now();
      const prev = config.servers.find((server) => server.name === input.name);
      const normalized = normalizeServer(input, prev);
      if (isErrorResult(normalized)) {
        return { ok: false, error: normalized.error, tools: [], durationMs: 0 };
      }
      if (probing) {
        return { ok: false, error: "已有自检在进行中，请稍后再试", tools: [], durationMs: 0 };
      }
      probing = true;
      try {
        const conn = new McpConnection({
          config: normalized,
          logs,
          logger,
          onChange: () => {},
          autoReconnect: () => false,
        });
        const outcome = await conn.probe();
        const tools = describeRawTools(outcome.tools);
        return {
          ...outcome,
          tools,
          durationMs: Date.now() - started,
        };
      } finally {
        probing = false;
      }
    },

    async callTool(publicName, args, callOptions) {
      const tool = api.getTool(publicName);
      if (!tool) {
        return {
          ok: false,
          text: `未知的 MCP 工具 "${publicName}"`,
          images: [],
          isError: true,
          durationMs: 0,
          truncated: false,
        };
      }
      const conn = connections.get(tool.server);
      if (!conn) {
        return {
          ok: false,
          text: `服务器 "${tool.server}" 不存在`,
          images: [],
          isError: true,
          durationMs: 0,
          truncated: false,
        };
      }

      const startedAt = Date.now();
      try {
        const raw = await concurrency.run(() =>
          conn.callTool(tool.tool, args ?? {}, {
            ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
            ...(callOptions?.timeoutMs
              ? { timeoutMs: Math.min(callOptions.timeoutMs, HARD_LIMITS.callTimeoutMs) }
              : {}),
          }),
        );
        const result = await normalizeCallToolResult(raw, {
          maxChars: config.maxResultChars,
          maxImages: config.maxResultImages,
          imageDir: callOptions?.imageDir ?? path.join(dataDir, "images"),
          startedAt,
        });
        logs.push(
          tool.server,
          result.isError ? "warn" : "info",
          `${tool.publicName} ${result.isError ? "失败" : "完成"} ${result.durationMs}ms${result.truncated ? " (截断)" : ""}`,
        );
        return result;
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        logs.push(tool.server, "error", `${tool.publicName} 调用失败：${message}`);
        return {
          ok: false,
          text: message,
          images: [],
          isError: true,
          durationMs: Date.now() - startedAt,
          truncated: false,
        } satisfies McpToolResult;
      }
    },

    recentLogs: (server?: string, limit?: number): McpLogEntry[] =>
      logs.list(server, limit),
  };

  const runtime: McpRuntime = {
    api,

    async start() {
      await loadFromDisk();
      await reconcile();
      startWatching();
    },

    async dispose() {
      disposed = true;
      if (watchTimer) clearTimeout(watchTimer);
      watcher?.close();
      watcher = undefined;
      // 并行关停，单个 1.5s 上限，绝不等待优雅收尾
      await Promise.allSettled(
        [...connections.values()].map((conn) => conn.close()),
      );
      connections.clear();
    },
  };

  return runtime;
}
