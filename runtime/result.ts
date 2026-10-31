import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { MAX_IMAGE_BYTES } from "../constants";
import type { McpToolImage, McpToolResult } from "../types";

export interface NormalizeResultOptions {
  /** 文本截断长度 */
  maxChars: number;
  /** 最多落盘几张图片 */
  maxImages: number;
  /** 图片落盘目录 */
  imageDir: string;
  /** 调用开始时间，用于计算 durationMs */
  startedAt?: number;
}

const STRUCTURED_INLINE_LIMIT = 2048;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "application/octet-stream": "bin",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extensionFor(mimeType: string): string {
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? "bin";
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0 || text.length <= max) return { text, truncated: false };
  const omitted = text.length - max;
  return {
    text: `${text.slice(0, max)}\n\n…[truncated, ${omitted} chars omitted]`,
    truncated: true,
  };
}

async function saveBinary(
  data: string,
  mimeType: string,
  imageDir: string,
  index: number,
): Promise<McpToolImage | { error: string }> {
  const buffer = Buffer.from(data, "base64");
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return {
      error: `[media omitted: ${buffer.byteLength} bytes exceeds ${MAX_IMAGE_BYTES}]`,
    };
  }
  await fsp.mkdir(imageDir, { recursive: true });
  const file = path.join(
    imageDir,
    `${Date.now().toString(36)}-${index}.${extensionFor(mimeType)}`,
  );
  await fsp.writeFile(file, buffer);
  return { path: file, mimeType, bytes: buffer.byteLength };
}

/** 把 MCP 的 content 数组折成模型能吃的文本 + 落盘的媒体 */
export async function normalizeCallToolResult(
  raw: unknown,
  options: NormalizeResultOptions,
): Promise<McpToolResult> {
  const record = isRecord(raw) ? raw : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const startedAt = options.startedAt ?? Date.now();

  const parts: string[] = [];
  const images: McpToolImage[] = [];
  let mediaIndex = 0;

  for (const item of content) {
    if (!isRecord(item)) continue;
    const type = String(item.type ?? "");

    if (type === "text") {
      const text = String(item.text ?? "");
      if (text) parts.push(text);
      continue;
    }

    if (type === "image" || type === "audio") {
      const data = String(item.data ?? "");
      const mimeType = String(item.mimeType ?? "application/octet-stream");
      if (!data) continue;
      if (images.length >= options.maxImages) {
        parts.push(`[${type} omitted: over the ${options.maxImages} media limit]`);
        continue;
      }
      const saved = await saveBinary(data, mimeType, options.imageDir, mediaIndex++);
      if ("error" in saved) {
        parts.push(saved.error);
        continue;
      }
      images.push(saved);
      if (type === "audio") {
        parts.push(`[audio saved: ${saved.path}]`);
      }
      continue;
    }

    if (type === "resource_link") {
      const name = String(item.name ?? item.uri ?? "");
      parts.push(`[resource] ${name} ${String(item.uri ?? "")}`.trim());
      continue;
    }

    if (type === "resource") {
      const resource = isRecord(item.resource) ? item.resource : {};
      const uri = String(resource.uri ?? "");
      if (typeof resource.text === "string" && resource.text.trim()) {
        parts.push(`[resource ${uri}]\n${resource.text}`);
        continue;
      }
      if (typeof resource.blob === "string" && resource.blob) {
        const mimeType = String(resource.mimeType ?? "application/octet-stream");
        if (images.length >= options.maxImages) {
          parts.push(`[resource ${uri} blob omitted: media limit reached]`);
          continue;
        }
        const saved = await saveBinary(resource.blob, mimeType, options.imageDir, mediaIndex++);
        if ("error" in saved) {
          parts.push(`[resource ${uri}] ${saved.error}`);
          continue;
        }
        images.push(saved);
        parts.push(`[resource ${uri} saved: ${saved.path}]`);
        continue;
      }
      parts.push(`[resource] ${uri}`);
    }
  }

  const structured = record.structuredContent;
  if (structured !== undefined) {
    const serialized = JSON.stringify(structured);
    if (serialized && serialized.length <= STRUCTURED_INLINE_LIMIT) {
      parts.push(`\`\`\`json\n${serialized}\n\`\`\``);
    } else if (serialized) {
      parts.push(`[structured output omitted: ${serialized.length} chars]`);
    }
  }

  const isError = record.isError === true;
  const joined = parts.join("\n\n").trim();
  const { text, truncated } = truncate(joined, options.maxChars);

  return {
    ok: !isError,
    text: text || (isError ? "MCP tool reported an error with no message" : ""),
    ...(structured !== undefined ? { structured } : {}),
    images,
    isError,
    durationMs: Date.now() - startedAt,
    truncated,
  };
}
