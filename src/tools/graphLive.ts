import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeMethod, BridgeRpcError } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { ProjectMeta } from '../projectContext.js';

const FlaxId = z.string().regex(/^[0-9a-fA-F]{32}$/, 'Expected a 32-character Flax GUID.');
const ContentPath = z.string().min(9).max(512).superRefine((value, ctx) => {
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value ||
    !normalized.startsWith('Content/') ||
    normalized.split('/').some(part => part.length === 0 || part === '.' || part === '..' || part.includes('\0'))
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected a project-relative path under Content/ without traversal.' });
  }
});
const Vector2 = z.object({ x: z.number().finite(), y: z.number().finite() }).strict();
const Vector3 = Vector2.extend({ z: z.number().finite() }).strict();
const Vector4 = Vector3.extend({ w: z.number().finite() }).strict();
// Bridge v16 graph writes accept only scalar/vector/color payloads. Asset
// references are rejected by the editor bridge with VALIDATION_FAILED.
const GraphValue = z.union([
  z.boolean(),
  z.number().finite(),
  z.string().max(512),
  Vector2,
  Vector3,
  Vector4,
]);
const GraphParameterType = z.enum(['boolean', 'integer', 'number', 'string', 'vector2', 'vector3', 'vector4', 'color']);
const AssetSelector = { asset_id: FlaxId.optional(), path: ContentPath.optional() };

function exactlyOneSelector(value: { asset_id?: string; path?: string }, ctx: z.RefinementCtx): void {
  if ((value.asset_id === undefined) === (value.path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of asset_id or path.' });
  }
}

function requiresConfirmation(value: { dry_run: boolean; confirm?: true }, ctx: z.RefinementCtx): void {
  if (!value.dry_run && value.confirm !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['confirm'], message: 'Set confirm: true when requesting a graph mutation.' });
  }
}

export const GraphInspectSchema = z.object({
  ...AssetSelector,
  include_values: z.boolean().optional().default(false),
  include_boxes: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(500).optional().default(200),
}).strict().superRefine(exactlyOneSelector);

export const GraphSetDefaultParameterSchema = z.object({
  ...AssetSelector,
  parameter_id: FlaxId.optional(),
  parameter_name: z.string().min(1).max(256).optional(),
  value: GraphValue,
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  exactlyOneSelector(value, ctx);
  if ((value.parameter_id === undefined) === (value.parameter_name === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of parameter_id or parameter_name.' });
  }
  requiresConfirmation(value, ctx);
});

export const GraphAddParameterSchema = z.object({
  ...AssetSelector,
  name: z.string().min(1).max(256),
  type: GraphParameterType,
  value: GraphValue.optional(),
  is_public: z.boolean().optional().default(true),
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

export const GraphUndoSchema = z.object({
  ...AssetSelector,
}).strict().superRefine(exactlyOneSelector);

function graphError(error: unknown): ToolDomainError {
  if (!(error instanceof BridgeRpcError)) {
    return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  if (error.code === 'BRIDGE_REMOTE_ERROR') {
    const remote = error.details as { code?: unknown; details?: unknown } | undefined;
    const code = remote?.code;
    if (code === 'ASSET_NOT_FOUND') return new ToolDomainError('ASSET_NOT_FOUND', error.message, remote?.details);
    if (code === 'NOT_FOUND') return new ToolDomainError('NOT_FOUND', error.message, remote?.details);
    if (code === 'EDITOR_BUSY') return new ToolDomainError('EDITOR_BUSY', error.message, remote?.details);
    if (code === 'INVALID_STATE') return new ToolDomainError('EDITOR_BUSY', error.message, remote?.details);
    if (code === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, remote?.details);
    if (code === 'RESPONSE_TOO_LARGE' || code === 'REQUEST_TOO_LARGE') return new ToolDomainError('CONTENT_TOO_LARGE', error.message, remote?.details);
    if (code === 'UNSUPPORTED_FLAX_VERSION') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, remote?.details);
    if (code === 'IDEMPOTENCY_KEY_REUSED') return new ToolDomainError('IDEMPOTENCY_KEY_REUSED', error.message, remote?.details);
    if (code === 'INVALID_REQUEST' || code === 'VALIDATION_FAILED') return new ToolDomainError('VALIDATION_FAILED', error.message, remote?.details);
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

async function graphCall(
  ctx: ProjectMeta,
  method: BridgeMethod,
  params: Record<string, unknown>,
  changes: unknown[] = [],
): Promise<ToolResponse> {
  // A hidden window opened by the bridge needs frames before
  // VisjectSurfaceWindow.Update() runs LoadSurface(). The bridge keeps the
  // window open and reports INVALID_STATE + details.NotReady; retry here so
  // callers never hand-pump retries. Bounded: 5 attempts, ~9s max.
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await callEditorBridge(ctx, method, params, { minimumBridgeVersion: 16 });
      const result = response.data as { Warnings?: unknown } | undefined;
      const warnings = Array.isArray(result?.Warnings)
        ? result.Warnings.filter((warning): warning is string => typeof warning === 'string')
        : response.warnings;
      const data = { result: response.data, bridge: response.bridge };
      return toolResult(JSON.stringify(data, null, 2), { mode: response.mode, data, warnings, changes });
    } catch (error) {
      lastError = error;
      const delay = graphNotReadyDelay(error);
      if (delay === null || attempt === 5) break;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return toolError(graphError(lastError));
}

function graphNotReadyDelay(error: unknown): number | null {
  if (!(error instanceof BridgeRpcError) || error.code !== 'BRIDGE_REMOTE_ERROR') return null;
  const remote = error.details as { code?: unknown; details?: unknown } | undefined;
  if (remote?.code !== 'INVALID_STATE') return null;
  const inner = remote.details as { NotReady?: unknown; RetryAfterMs?: unknown } | undefined;
  if (inner?.NotReady !== true) return null;
  const hint = typeof inner.RetryAfterMs === 'number' && Number.isFinite(inner.RetryAfterMs) ? inner.RetryAfterMs : 1500;
  return Math.min(Math.max(hint, 250), 5000);
}

function selector(args: { asset_id?: string; path?: string }): Record<string, unknown> {
  return { AssetId: args.asset_id, Path: args.path };
}

export const handleGraphInspect = (args: z.infer<typeof GraphInspectSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.inspect', {
    ...selector(args),
    IncludeValues: args.include_values,
    IncludeBoxes: args.include_boxes,
    Limit: args.limit,
  });

export const handleGraphSetDefaultParameter = (args: z.infer<typeof GraphSetDefaultParameterSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.set_default_parameter', {
    ...selector(args),
    ParameterId: args.parameter_id,
    ParameterName: args.parameter_name,
    Value: toBridgeValue(args.value),
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
  }, args.dry_run ? [] : [{ kind: 'graph-parameter', asset_id: args.asset_id, path: args.path }]);

export const handleGraphAddParameter = (args: z.infer<typeof GraphAddParameterSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.add_parameter', {
    ...selector(args),
    Name: args.name,
    Type: args.type,
    Value: args.value === undefined ? undefined : toBridgeValue(args.value),
    IsPublic: args.is_public,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
  }, args.dry_run ? [] : [{ kind: 'graph-parameter', asset_id: args.asset_id, path: args.path }]);

export const handleGraphUndo = (args: z.infer<typeof GraphUndoSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.undo', { ...selector(args) });

function toBridgeValue(value: unknown): unknown {
  if (typeof value === 'boolean') return { Kind: 'boolean', Boolean: value };
  if (typeof value === 'number') return { Kind: 'number', Number: value };
  if (typeof value === 'string') return { Kind: 'string', Text: value };
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, number>;
    if (typeof record.w === 'number') return { Kind: 'vector4', Vector4: { X: record.x, Y: record.y, Z: record.z, W: record.w } };
    if (typeof record.z === 'number') return { Kind: 'vector3', Vector3: { X: record.x, Y: record.y, Z: record.z } };
    return { Kind: 'vector2', Vector2: { X: record.x, Y: record.y } };
  }
  return value;
}
