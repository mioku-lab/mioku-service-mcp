import { LOG_LIMIT_PER_SERVER } from "../constants";
import type { McpLogEntry } from "../types";

/** 每个服务器一个定长环形缓冲，超出后丢最旧的 */
export class McpLogs {
  private readonly entries = new Map<string, McpLogEntry[]>();

  push(
    server: string,
    level: McpLogEntry["level"],
    message: string,
  ): void {
    const list = this.entries.get(server) ?? [];
    list.push({ at: Date.now(), server, level, message });
    if (list.length > LOG_LIMIT_PER_SERVER) {
      list.splice(0, list.length - LOG_LIMIT_PER_SERVER);
    }
    this.entries.set(server, list);
  }

  list(server?: string, limit = LOG_LIMIT_PER_SERVER): McpLogEntry[] {
    const all = server
      ? [...(this.entries.get(server) ?? [])]
      : [...this.entries.values()].flat().sort((a, b) => a.at - b.at);
    return limit > 0 ? all.slice(-limit) : all;
  }

  clear(server?: string): void {
    if (server) this.entries.delete(server);
    else this.entries.clear();
  }
}
