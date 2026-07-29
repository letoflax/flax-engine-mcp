import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, type ToolResponse } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';
import { isTerminalOperation, startHeavyOperation, type OperationHandle } from '../operations.js';

const OperationId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character operation ID.');
const OutputPath = z.string().min(8).max(512).superRefine((value, ctx) => {
  if (value.replaceAll('\\', '/') !== value || !value.startsWith('Builds/') || value.endsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative non-empty directory under Builds/ without traversal.' });
  }
});
const BuildPlatform = z.enum(['windows64', 'linux_x64', 'macos_x64', 'macos_arm64', 'android_arm64', 'web']);
const BuildConfiguration = z.enum(['debug', 'development', 'release']);
const BuildDefine = z.string().min(1).max(64).regex(/^[A-Za-z0-9_]+$/, 'Build defines must be identifier-like values.');

export const BuildListTargetsSchema = z.object({}).strict();
export const BuildValidateSchema = z.object({
  platform: BuildPlatform,
  configuration: BuildConfiguration.optional().default('development'),
  output_path: OutputPath,
  custom_defines: z.array(BuildDefine).max(32).optional().default([]),
}).strict();
export const BuildCookSchema = BuildValidateSchema.extend({
  operation_id: OperationId.optional(),
  dry_run: z.boolean().optional().default(false),
  wait: z.boolean().optional().default(false),
  timeout_ms: z.number().int().min(250).max(120_000).optional().default(30_000),
}).strict();
export const BuildOperationSchema = z.object({ operation_id: OperationId }).strict();

function buildError(error: unknown): ToolDomainError {
  if (error instanceof ToolDomainError) return error;
  if (!(error instanceof BridgeRpcError)) return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  const remote = error.details as { code?: unknown; details?: unknown } | undefined;
  const code = remote?.code;
  if (code === 'EDITOR_BUSY') return new ToolDomainError('EDITOR_BUSY', error.message, remote?.details);
  if (code === 'OPERATION_NOT_FOUND') return new ToolDomainError('OPERATION_NOT_FOUND', error.message, remote?.details);
  if (code === 'BUILD_NOT_COMPLETE') return new ToolDomainError('BUILD_NOT_COMPLETE', error.message, remote?.details);
  if (code === 'CANCELLATION_UNSUPPORTED') return new ToolDomainError('CANCELLATION_UNSUPPORTED', error.message, remote?.details);
  if (code === 'BUILD_START_FAILED' || code === 'BUILD_FAILED') return new ToolDomainError('BUILD_FAILED', error.message, remote?.details);
  if (code === 'INVALID_REQUEST' || code === 'VALIDATION_FAILED') return new ToolDomainError('VALIDATION_FAILED', error.message, remote?.details);
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

function params(args: z.infer<typeof BuildValidateSchema>, operationId?: string, dryRun?: boolean): Record<string, unknown> {
  return {
    OperationId: operationId,
    Platform: args.platform,
    Configuration: args.configuration,
    OutputPath: args.output_path,
    CustomDefines: args.custom_defines,
    DryRun: dryRun,
  };
}

function success(data: unknown, bridge: unknown, warnings: string[] = [], changes: unknown[] = []): ToolResponse {
  return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings, changes });
}

async function buildStatus(ctx: ProjectMeta, operationId: string, result = false): Promise<{ operation: OperationHandle; bridge: unknown; warnings: string[] }> {
  const method = result ? 'build.result' : 'build.status';
  const response = await callEditorBridge(ctx, method, { OperationId: operationId }, { minimumBridgeVersion: 13, deadlineMs: 15_000 });
  return { operation: response.data as OperationHandle, bridge: response.bridge, warnings: response.warnings };
}

async function waitForBuild(ctx: ProjectMeta, operationId: string, timeoutMs: number): Promise<{ operation: OperationHandle; bridge: unknown; warnings: string[]; pending: boolean }> {
  const end = Date.now() + timeoutMs;
  let last: { operation: OperationHandle; bridge: unknown; warnings: string[] } | undefined;
  while (Date.now() <= end) {
    last = await buildStatus(ctx, operationId);
    if (isTerminalOperation(last.operation)) return { ...last, pending: false };
    await new Promise<void>(resolve => setTimeout(resolve, 150));
  }
  if (!last) last = await buildStatus(ctx, operationId);
  return { ...last, pending: true };
}

export async function handleBuildListTargets(_: z.infer<typeof BuildListTargetsSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, 'build.list_targets', {}, { minimumBridgeVersion: 13 });
    const record = response.data as { Warnings?: unknown };
    const warnings = Array.isArray(record?.Warnings) ? record.Warnings.filter((item): item is string => typeof item === 'string') : response.warnings;
    return success({ result: response.data, bridge: response.bridge }, response.bridge, warnings);
  } catch (error) { return toolError(buildError(error)); }
}

export async function handleBuildValidate(args: z.infer<typeof BuildValidateSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, 'build.validate', params(args), { minimumBridgeVersion: 13 });
    const validation = response.data as { Valid?: boolean; Warnings?: unknown };
    const warnings = Array.isArray(validation.Warnings) ? validation.Warnings.filter((item): item is string => typeof item === 'string') : response.warnings;
    return success({ validation, bridge: response.bridge }, response.bridge, warnings);
  } catch (error) { return toolError(buildError(error)); }
}

export async function handleBuildCook(args: z.infer<typeof BuildCookSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const operationId = args.operation_id ?? randomUUID().replaceAll('-', '');
    const response = await startHeavyOperation(ctx, () => callEditorBridge(ctx, 'build.cook', params(args, operationId, args.dry_run), { minimumBridgeVersion: 13, deadlineMs: 30_000 }));
    const initial = response.data as OperationHandle;
    const waited = args.wait && !isTerminalOperation(initial) ? await waitForBuild(ctx, operationId, args.timeout_ms) : { operation: initial, bridge: response.bridge, warnings: response.warnings, pending: !isTerminalOperation(initial) };
    const data = { operation: waited.operation, bridge: waited.bridge, pending: waited.pending };
    return success(data, waited.bridge, waited.pending ? [...waited.warnings, 'Build is still running; poll build_get_status with this operation_id or request build_cancel.'] : waited.warnings,
      args.dry_run ? [] : [{ kind: 'build.cook.started', operationId, platform: args.platform, configuration: args.configuration, outputPath: args.output_path }]);
  } catch (error) { return toolError(buildError(error)); }
}

export async function handleBuildGetStatus(args: z.infer<typeof BuildOperationSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const status = await buildStatus(ctx, args.operation_id);
    return success({ operation: status.operation, bridge: status.bridge }, status.bridge, status.warnings);
  } catch (error) { return toolError(buildError(error)); }
}

export async function handleBuildGetResult(args: z.infer<typeof BuildOperationSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const status = await buildStatus(ctx, args.operation_id, true);
    return success({ operation: status.operation, bridge: status.bridge }, status.bridge, status.warnings);
  } catch (error) { return toolError(buildError(error)); }
}

export async function handleBuildCancel(args: z.infer<typeof BuildOperationSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, 'build.cancel', { OperationId: args.operation_id }, { minimumBridgeVersion: 13 });
    return success({ operation: response.data, bridge: response.bridge }, response.bridge, response.warnings, [{ kind: 'build.cook.cancel', operationId: args.operation_id }]);
  } catch (error) { return toolError(buildError(error)); }
}
