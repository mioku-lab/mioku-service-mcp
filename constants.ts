export const SERVICE_NAME = "mcp";

/** 服务给 MCP 服务器上报的客户端标识 */
export const CLIENT_NAME = "mioku";
export const CLIENT_VERSION = "0.1.0";

/** 连接与调用的硬上限，任何配置都不能突破 */
export const HARD_LIMITS = {
  connectTimeoutMs: 60_000,
  callTimeoutMs: 300_000,
  maxResultChars: 200_000,
  maxConcurrency: 16,
  maxTools: 256,
} as const;

/** 每个服务器的日志条数上限（含 stderr） */
export const LOG_LIMIT_PER_SERVER = 100;

/** 工具结果里单张图片的大小上限 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** 工具 schema 序列化后的上限，超过就降级 */
export const MAX_SCHEMA_BYTES = 8 * 1024;

/** 重连退避的上限 */
export const MAX_RECONNECT_DELAY_MS = 30_000;

/** 连续重连失败多少次后停在 error 态等人工介入 */
export const MAX_RECONNECT_ATTEMPTS = 5;

/** 服务器名：同时作为工具名前缀 */
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/** 模型侧工具名的硬约束（OpenAI / Anthropic 的 function name） */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const TOOL_NAME_MAX = 64;

/** 密钥字段在读取接口里的占位符 */
export const SECRET_MASK = "****";
