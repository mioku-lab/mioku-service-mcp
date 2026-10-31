import { MAX_SCHEMA_BYTES } from "../constants";
import type { McpToolSchema } from "../types";

const MAX_REF_DEPTH = 3;
const MAX_DESCRIPTION_DEPTH = 2;
const MAX_DESCRIPTION_LENGTH = 400;

/** 只保留 provider 认识的键 */
const KEPT_KEYS = new Set([
  "type",
  "properties",
  "required",
  "description",
  "enum",
  "const",
  "items",
  "default",
  "anyOf",
  "oneOf",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "additionalProperties",
  "nullable",
  "format",
]);

const PERMISSIVE_SCHEMA: McpToolSchema = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

export interface NormalizedSchema {
  schema: McpToolSchema;
  /** 结构不可用或超出体积上限，已换成宽松 schema */
  degraded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** `#/$defs/x` 与 `#/definitions/x` 都能解 */
function lookupRef(ref: string, defs: Record<string, unknown>): unknown {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return undefined;
  let current: unknown = defs;
  for (const segment of match[1]!.split("/")) {
    if (!isRecord(current)) return undefined;
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current[key];
  }
  return current;
}

function resolveRefs(
  node: unknown,
  defs: Record<string, unknown>,
  depth: number,
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(item, defs, depth));
  }
  if (!isRecord(node)) return node;

  const ref = node.$ref;
  if (typeof ref === "string") {
    const target = lookupRef(ref, defs);
    // 解不动或已经太深：整个引用丢掉，交给上层判定是否降级
    if (target === undefined || depth >= MAX_REF_DEPTH) return undefined;
    const { $ref: _ref, ...rest } = node;
    const resolved = resolveRefs(target, defs, depth + 1);
    const extra = resolveRefs(rest, defs, depth);
    if (!isRecord(resolved)) return resolved;
    return isRecord(extra) ? { ...resolved, ...extra } : resolved;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = resolveRefs(value, defs, depth);
  }
  return out;
}

/** 剥掉 provider 不认识的键，并做几处保守改写 */
function prune(node: unknown, depth: number): unknown {
  if (Array.isArray(node)) return node.map((item) => prune(item, depth));
  if (!isRecord(node)) return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null) continue;

    if (key === "description") {
      if (depth > MAX_DESCRIPTION_DEPTH) continue;
      const text = String(value);
      out.description =
        text.length > MAX_DESCRIPTION_LENGTH
          ? `${text.slice(0, MAX_DESCRIPTION_LENGTH)}…`
          : text;
      continue;
    }

    if (key === "properties") {
      if (!isRecord(value)) continue;
      const props: Record<string, unknown> = {};
      for (const [propKey, propValue] of Object.entries(value)) {
        props[propKey] = prune(propValue, depth + 1);
      }
      out.properties = props;
      continue;
    }

    if (key === "items" || key === "anyOf" || key === "oneOf") {
      out[key] = prune(value, depth + 1);
      continue;
    }

    if (!KEPT_KEYS.has(key)) continue;

    if (key === "type") {
      // OpenAI 不接受 type 数组；取第一个非 null 成员
      if (Array.isArray(value)) {
        const picked = value.map(String).find((item) => item !== "null");
        if (picked) out.type = picked;
        continue;
      }
      out.type = value;
      continue;
    }

    out[key] = value;
  }
  return out;
}

/** 去掉深层描述，用于体积超限时的第二次尝试 */
function stripDeepDescriptions(node: unknown, depth: number): unknown {
  if (Array.isArray(node))
    return node.map((item) => stripDeepDescriptions(item, depth));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description" && depth > 1) continue;
    out[key] = stripDeepDescriptions(value, depth + 1);
  }
  return out;
}

export function normalizeToolSchema(raw: unknown): NormalizedSchema {
  if (!isRecord(raw))
    return { schema: { ...PERMISSIVE_SCHEMA }, degraded: true };

  const defs = isRecord(raw.$defs)
    ? raw.$defs
    : isRecord(raw.definitions)
      ? raw.definitions
      : {};

  const resolved = resolveRefs(raw, defs, 0);
  if (!isRecord(resolved))
    return { schema: { ...PERMISSIVE_SCHEMA }, degraded: true };

  const pruned = prune(resolved, 0);
  if (!isRecord(pruned))
    return { schema: { ...PERMISSIVE_SCHEMA }, degraded: true };

  // provider 要求顶层必须是 object
  if (pruned.type !== "object" || !isRecord(pruned.properties)) {
    return { schema: { ...PERMISSIVE_SCHEMA }, degraded: true };
  }

  let candidate: Record<string, unknown> = pruned;
  if (JSON.stringify(candidate).length > MAX_SCHEMA_BYTES) {
    const trimmed = stripDeepDescriptions(candidate, 0);
    if (
      isRecord(trimmed) &&
      JSON.stringify(trimmed).length <= MAX_SCHEMA_BYTES
    ) {
      candidate = trimmed;
    } else {
      return { schema: { ...PERMISSIVE_SCHEMA }, degraded: true };
    }
  }

  const schema: McpToolSchema = {
    type: "object",
    properties: candidate.properties as Record<string, unknown>,
  };
  if (Array.isArray(candidate.required)) {
    const required = candidate.required
      .map(String)
      .filter((item) => item.length > 0);
    if (required.length > 0) schema.required = required;
  }
  if (candidate.additionalProperties === false)
    schema.additionalProperties = false;

  return { schema, degraded: false };
}
