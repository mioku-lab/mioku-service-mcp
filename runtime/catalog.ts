import { md5 } from "mioku";
import { TOOL_NAME_MAX } from "../constants";
import { normalizeToolSchema } from "./schema";
import type { McpServerConfig, McpToolFilter, McpToolInfo } from "../types";

/** tools/list 返回的原始工具 */
export interface RawTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface CatalogInput {
  server: McpServerConfig;
  raw: RawTool[];
}

const PUBLIC_NAME_PREFIX = "mcp";

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

function shortHash(value: string): string {
  return String(md5(value)).slice(0, 8);
}

/** 把 `*` / `?` 通配转成正则，用于 toolFilter */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

function matchFilter(filter: McpToolFilter | undefined, name: string): boolean {
  if (!filter) return true;
  if (filter.deny?.some((pattern) => globToRegExp(pattern).test(name))) {
    return false;
  }
  if (filter.allow && filter.allow.length > 0) {
    return filter.allow.some((pattern) => globToRegExp(pattern).test(name));
  }
  return true;
}

/**
 * 模型侧工具名：`mcp__<server>__<tool>`，满足 `^[A-Za-z0-9_-]{1,64}$`。
 * 超长或撞名时截断并追加稳定哈希。
 */
function assignPublicNames(
  candidates: Array<{ server: string; tool: string }>,
): string[] {
  const used = new Set<string>();
  return candidates.map(({ server, tool }) => {
    const head = `${PUBLIC_NAME_PREFIX}__${sanitizeSegment(server)}__`;
    const body = sanitizeSegment(tool) || "tool";
    let name = `${head}${body}`;
    if (name.length > TOOL_NAME_MAX || used.has(name)) {
      const hash = shortHash(`${server}/${tool}`);
      const room = TOOL_NAME_MAX - head.length - hash.length - 1;
      name = `${head}${body.slice(0, Math.max(1, room))}_${hash}`;
    }
    used.add(name);
    return name;
  });
}

/** 按服务器轮流取，保证大服务器不会把别的服务器的额度吃光 */
function interleave(groups: McpToolInfo[][]): McpToolInfo[] {
  const out: McpToolInfo[] = [];
  const cursors = groups.map(() => 0);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      const index = cursors[i]!;
      if (index >= group.length) continue;
      out.push(group[index]!);
      cursors[i] = index + 1;
      progressed = true;
    }
  }
  return out;
}

/**
 * 生成全局目录。
 * 服务器级与全局的 `maxTools` 决定谁拿到带 schema 的一等工具位，
 * 溢出的不丢弃：保留名字与描述进目录，模型仍能用 `mcp_call` 调它们。
 * 结果与输入顺序无关，逐轮稳定（prompt 前缀缓存友好）。
 */
export function buildCatalog(
  inputs: CatalogInput[],
  globalMaxTools: number,
): McpToolInfo[] {
  const ordered = [...inputs].sort((a, b) => a.server.name.localeCompare(b.server.name));

  const primaryGroups: McpToolInfo[][] = [];
  const overflow: McpToolInfo[] = [];

  for (const { server, raw } of ordered) {
    const kept = raw
      .filter((tool) => Boolean(tool?.name))
      .filter((tool) => matchFilter(server.toolFilter, tool.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    // 先给全部候选分配名字，避免一等工具与溢出工具之间撞名
    const names = assignPublicNames(
      kept.map((tool) => ({ server: server.name, tool: tool.name })),
    );

    const all: McpToolInfo[] = kept.map((tool, index) => {
      const { schema } = normalizeToolSchema(tool.inputSchema);
      return {
        publicName: names[index]!,
        tool: tool.name,
        server: server.name,
        description: String(tool.description ?? "").trim(),
        parameters: schema,
        catalogOnly: false,
      } satisfies McpToolInfo;
    });

    const budget =
      server.maxTools && server.maxTools > 0 ? server.maxTools : all.length;
    primaryGroups.push(all.slice(0, budget));
    overflow.push(...all.slice(budget));
  }

  const flat = interleave(primaryGroups);
  const limit = globalMaxTools > 0 ? globalMaxTools : flat.length;
  const primaries = flat.map((tool, index) => ({
    ...tool,
    catalogOnly: index >= limit,
  }));

  overflow.sort((a, b) => a.publicName.localeCompare(b.publicName));
  return [...primaries, ...overflow.map((tool) => ({ ...tool, catalogOnly: true }))];
}

/** 单个服务器的工具（自检面板用），不做全局预算 */
export function describeRawTools(raw: RawTool[]): Array<{ name: string; description: string }> {
  return raw
    .filter((tool) => Boolean(tool?.name))
    .map((tool) => ({
      name: tool.name,
      description: String(tool.description ?? "").trim(),
    }));
}
