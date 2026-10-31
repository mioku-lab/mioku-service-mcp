import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Transport } from "@modelcontextprotocol/client";
import type { Stream } from "node:stream";
import type { McpServerConfig } from "../types";

export interface CreatedTransport {
  transport: Transport;
  /** stdio 子进程的 stderr；http / sse 没有 */
  stderr: Stream | null;
}

/** 展示用目标：stdio 是命令行，http / sse 是地址 */
export function describeTarget(cfg: McpServerConfig): string {
  if (cfg.transport === "stdio") {
    return [cfg.command ?? "", ...(cfg.args ?? [])].join(" ").trim();
  }
  return cfg.url ?? "";
}

export function createTransport(cfg: McpServerConfig): CreatedTransport {
  if (cfg.transport === "stdio") {
    const transport = new StdioClientTransport({
      command: cfg.command!,
      ...(cfg.args ? { args: cfg.args } : {}),
      ...(cfg.env ? { env: cfg.env } : {}),
      ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
      stderr: "pipe",
    });
    return { transport, stderr: transport.stderr };
  }

  const url = new URL(cfg.url!);
  const requestInit: RequestInit = cfg.headers
    ? { headers: { ...cfg.headers } }
    : {};
  const transport =
    cfg.transport === "sse"
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  return { transport, stderr: null };
}
