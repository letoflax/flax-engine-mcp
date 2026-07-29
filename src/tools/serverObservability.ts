import { z } from 'zod';
import { getRecentServerErrors, getServerMetrics } from '../observability.js';
import { ProjectMeta } from '../projectContext.js';
import { toolError, toolResult, ToolResponse } from '../errors.js';
import { inspectEditorBridge } from './serverStatus.js';

export const ServerGetHealthSchema = z.object({});
export const ServerGetMetricsSchema = z.object({});
export const ServerGetRecentErrorsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(25),
});

export async function handleServerGetHealth(_args: unknown, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const bridge = await inspectEditorBridge(ctx);
    const metrics = getServerMetrics();
    const data = {
      status: bridge.connected ? 'healthy' : 'degraded',
      telemetry: 'disabled',
      bridge: { connected: bridge.connected, reason: bridge.reason, protocolVersion: bridge.protocolVersion, bridgeVersion: bridge.bridgeVersion },
      metrics: { uptimeMs: metrics.uptimeMs, toolCalls: metrics.toolCalls, ipc: metrics.ipc },
    };
    return toolResult(JSON.stringify(data, null, 2), { data, mode: bridge.connected ? 'editor-connected' : 'offline' });
  } catch (error) { return toolError(error); }
}

export async function handleServerGetMetrics(_args: unknown, _ctx: ProjectMeta): Promise<ToolResponse> {
  const data = getServerMetrics();
  return toolResult(JSON.stringify(data, null, 2), { data });
}

export async function handleServerGetRecentErrors(args: z.infer<typeof ServerGetRecentErrorsSchema>, _ctx: ProjectMeta): Promise<ToolResponse> {
  const data = { entries: getRecentServerErrors(args.limit), maxEntries: 100, redacted: true };
  return toolResult(JSON.stringify(data, null, 2), { data });
}
