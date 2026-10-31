import { defineService, ensureDataDir, getServiceConfigDir, logger, registerServiceConfig } from "mioku";
import type { MiokuService } from "mioku";
import { SERVICE_NAME } from "./constants";
import { MCP_DEFAULTS } from "./config";
import { createMcpRuntime } from "./runtime/service";
import type { McpRuntime } from "./runtime/service";
import type { McpServiceApi } from "./types";

export const McpService = defineService<McpServiceApi>(SERVICE_NAME);

export type {
  McpApprovalMode,
  McpConfig,
  McpLogEntry,
  McpProbeResult,
  McpProbeTool,
  McpServerCapabilities,
  McpServerConfig,
  McpServerInput,
  McpServerState,
  McpServerStatus,
  McpServiceApi,
  McpToolFilter,
  McpToolImage,
  McpToolInfo,
  McpToolResult,
  McpToolSchema,
  McpTransportKind,
} from "./types";
export { MCP_DEFAULTS, maskServerSecrets, normalizeConfig, normalizeServer } from "./config";
export { SERVICE_NAME } from "./constants";

let runtime: McpRuntime | null = null;

const mcpService: MiokuService = {
  name: SERVICE_NAME,
  api: {} as McpServiceApi,

  async init() {
    await registerServiceConfig(
      SERVICE_NAME,
      "servers",
      MCP_DEFAULTS as unknown as Record<string, unknown>,
    );

    runtime = createMcpRuntime({
      logger,
      dataDir: ensureDataDir(SERVICE_NAME),
      configDir: getServiceConfigDir(SERVICE_NAME),
    });
    await runtime.start();
    this.api = runtime.api;

    const servers = runtime.api.listServers();
    const ready = servers.filter((server) => server.state === "ready").length;
    logger.info(
      `mcp-service 已就绪：${servers.length} 个服务器，${ready} 个已连接，${runtime.api.listTools().length} 个工具`,
    );
  },

  async dispose() {
    await runtime?.dispose();
    runtime = null;
    logger.info("mcp-service 已卸载");
  },
};

export default mcpService;
