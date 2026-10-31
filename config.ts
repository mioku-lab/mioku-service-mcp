import {
  HARD_LIMITS,
  SECRET_MASK,
  SERVER_NAME_PATTERN,
} from "./constants";
import type {
  McpApprovalMode,
  McpConfig,
  McpServerConfig,
  McpServerInput,
  McpToolFilter,
  McpTransportKind,
} from "./types";

export const MCP_DEFAULTS: McpConfig = {
  autoConnect: true,
  reconnectDelayMs: 2000,
  maxConcurrency: 4,
  maxTools: 64,
  maxResultChars: 20_000,
  maxResultImages: 4,
  servers: [],
};

const TRANSPORTS: readonly McpTransportKind[] = ["stdio", "http", "sse"];
const APPROVALS: readonly McpApprovalMode[] = ["never", "always", "auto"];

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown, fallback: number, max: number): number {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(num, max);
}

function nonNegative(value: unknown, fallback: number, max: number): number {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.min(num, max);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim();
    if (!name) continue;
    out[name] = String(raw ?? "");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item ?? "")).filter((item) => item.length > 0);
}

function toolFilter(value: unknown): McpToolFilter | undefined {
  if (!isRecord(value)) return undefined;
  const allow = stringList(value.allow);
  const deny = stringList(value.deny);
  if (!allow && !deny) return undefined;
  return { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
}

/** 全局配置归一化；非法值退回默认，不抛异常 */
export function normalizeConfig(raw: unknown): McpConfig {
  const input = isRecord(raw) ? raw : {};
  const servers = Array.isArray(input.servers) ? input.servers : [];
  return {
    autoConnect: input.autoConnect !== false,
    reconnectDelayMs: nonNegative(
      input.reconnectDelayMs,
      MCP_DEFAULTS.reconnectDelayMs,
      60_000,
    ),
    maxConcurrency: positive(
      input.maxConcurrency,
      MCP_DEFAULTS.maxConcurrency,
      HARD_LIMITS.maxConcurrency,
    ),
    maxTools: nonNegative(input.maxTools, MCP_DEFAULTS.maxTools, HARD_LIMITS.maxTools),
    maxResultChars: positive(
      input.maxResultChars,
      MCP_DEFAULTS.maxResultChars,
      HARD_LIMITS.maxResultChars,
    ),
    maxResultImages: nonNegative(input.maxResultImages, MCP_DEFAULTS.maxResultImages, 16),
    servers: servers
      .map((item) => normalizeServer(item))
      .filter((item): item is McpServerConfig => item !== null),
  };
}

export interface ServerInputError {
  error: string;
}

/** 单个服务器归一化；name 或传输方式非法时返回错误 */
export function normalizeServer(
  raw: unknown,
  prev?: McpServerConfig,
): McpServerConfig | ServerInputError {
  const input = isRecord(raw) ? raw : {};
  const name = String(input.name ?? "").trim().toLowerCase();
  if (!SERVER_NAME_PATTERN.test(name)) {
    return {
      error: `服务器名 "${name}" 非法：只允许小写字母、数字、下划线与短横，1-24 字符，且以字母或数字开头`,
    };
  }

  const transport = TRANSPORTS.includes(input.transport as McpTransportKind)
    ? (input.transport as McpTransportKind)
    : "stdio";

  const next: McpServerConfig = {
    name,
    enabled: input.enabled === true,
    transport,
    approval: APPROVALS.includes(input.approval as McpApprovalMode)
      ? (input.approval as McpApprovalMode)
      : "always",
    timeoutMs: positive(input.timeoutMs, DEFAULT_CALL_TIMEOUT_MS, HARD_LIMITS.callTimeoutMs),
    connectTimeoutMs: positive(
      input.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      HARD_LIMITS.connectTimeoutMs,
    ),
  };

  const description = String(input.description ?? "").trim();
  if (description) next.description = description;

  if (transport === "stdio") {
    const command = String(input.command ?? "").trim();
    if (!command) return { error: `服务器 "${name}" 缺少 command` };
    next.command = command;
    const args = stringList(input.args);
    if (args && args.length > 0) next.args = args;
    const cwd = String(input.cwd ?? "").trim();
    if (cwd) next.cwd = cwd;
    const env = stringMap(input.env);
    if (env) next.env = env;
  } else {
    const url = String(input.url ?? "").trim();
    if (!url) return { error: `服务器 "${name}" 缺少 url` };
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { error: `服务器 "${name}" 的 url 只支持 http/https` };
      }
    } catch {
      return { error: `服务器 "${name}" 的 url 不是合法地址` };
    }
    next.url = url;
    const headers = stringMap(input.headers);
    if (headers) next.headers = headers;
  }

  const maxTools = nonNegative(input.maxTools, 0, HARD_LIMITS.maxTools);
  if (maxTools > 0) next.maxTools = maxTools;
  const filter = toolFilter(input.toolFilter);
  if (filter) next.toolFilter = filter;

  return restoreSecrets(next, prev);
}

/**
 * 写接口收到 `****` 表示"这一项没改"，回填旧值。
 * 新增服务器时没有旧值可回填，直接丢弃占位符。
 */
function restoreSecrets(
  next: McpServerConfig,
  prev?: McpServerConfig,
): McpServerConfig {
  const fix = (
    incoming: Record<string, string> | undefined,
    previous: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    if (!incoming) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (value === SECRET_MASK) {
        if (previous && key in previous) out[key] = previous[key]!;
        continue;
      }
      out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  if (next.env) {
    const env = fix(next.env, prev?.env);
    if (env) next.env = env;
    else delete next.env;
  }
  if (next.headers) {
    const headers = fix(next.headers, prev?.headers);
    if (headers) next.headers = headers;
    else delete next.headers;
  }
  return next;
}

/** 读接口把密钥字段换成占位符 */
export function maskServerSecrets(server: McpServerConfig): McpServerConfig {
  const mask = (
    source: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    if (!source) return undefined;
    const out: Record<string, string> = {};
    for (const key of Object.keys(source)) out[key] = SECRET_MASK;
    return out;
  };
  const masked: McpServerConfig = { ...server };
  if (server.env) masked.env = mask(server.env);
  if (server.headers) masked.headers = mask(server.headers);
  return masked;
}

/** 从写入入参构造一个完整配置，用于 probe 这类不落盘的场景 */
export function inputToServer(input: McpServerInput): McpServerConfig | ServerInputError {
  return normalizeServer(input);
}
