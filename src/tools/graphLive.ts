import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { mapBridgeError } from '../bridge/mapBridgeError.js';
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
  include_subcontexts: z.boolean().optional().default(false),
  max_depth: z.number().int().min(1).max(5).optional().default(3),
}).strict().superRefine(exactlyOneSelector);

export const GraphSetDefaultParameterSchema = z.object({
  ...AssetSelector,
  parameter_id: FlaxId.optional(),
  parameter_name: z.string().min(1).max(256).optional(),
  value: GraphValue,
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  lease_id: FlaxId.optional(),
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
  lease_id: FlaxId.optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

export const GraphUndoSchema = z.object({
  ...AssetSelector,
}).strict().superRefine(exactlyOneSelector);

export const GraphRemoveNodeSchema = z.object({
  ...AssetSelector,
  node_id: z.number().int().min(0),
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  lease_id: FlaxId.optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

export const GraphDisconnectSchema = z.object({
  ...AssetSelector,
  from_node: z.number().int().min(0),
  from_box: z.number().int().min(0),
  to_node: z.number().int().min(0),
  to_box: z.number().int().min(0),
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  lease_id: FlaxId.optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

const GraphNodeValue = z.union([
  GraphValue,
  z.object({ asset_id: FlaxId }).strict(),
]);

export const GraphSetNodeValuesSchema = z.object({
  ...AssetSelector,
  node_id: z.number().int().min(0),
  values: z.array(z.object({
    index: z.number().int().min(0).max(64),
    value: GraphNodeValue,
  }).strict()).min(1).max(32),
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  lease_id: FlaxId.optional(),
}).strict().superRefine((value, ctx) => {
  exactlyOneSelector(value, ctx);
  requiresConfirmation(value, ctx);
  const indexes = value.values.map(entry => entry.index);
  if (new Set(indexes).size !== indexes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Value indexes must be unique.' });
  }
});

export const GraphMoveNodeSchema = z.object({
  ...AssetSelector,
  node_id: z.number().int().min(0),
  x: z.number().finite().min(-10000).max(10000),
  y: z.number().finite().min(-10000).max(10000),
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  lease_id: FlaxId.optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

export const AnimgraphSetStateClipSchema = z.object({
  ...AssetSelector,
  state: z.string().min(1).max(256),
  clip_asset_id: FlaxId.optional(),
  clip_path: ContentPath.optional(),
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  lease_id: FlaxId.optional(),
}).strict().superRefine((value, ctx) => {
  exactlyOneSelector(value, ctx);
  requiresConfirmation(value, ctx);
  if ((value.clip_asset_id === undefined) === (value.clip_path === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide exactly one of clip_asset_id or clip_path.' });
  }
});

const FiniteCoordinate = z.number().finite().min(-10000).max(10000).optional();

export const AnimgraphAddStateSchema = z.object({
  ...AssetSelector,
  name: z.string().min(1).max(256),
  x: FiniteCoordinate,
  y: FiniteCoordinate,
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  lease_id: FlaxId.optional(),
}).strict().superRefine((value, ctx) => {
  exactlyOneSelector(value, ctx);
  requiresConfirmation(value, ctx);
  if ((value.x === undefined) !== (value.y === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide both x and y, or neither for auto-layout.' });
  }
});

export const AnimgraphAddTransitionSchema = z.object({
  ...AssetSelector,
  from_state: z.string().min(1).max(256),
  to_state: z.string().min(1).max(256),
  dry_run: z.boolean().optional().default(true),
  confirm: z.literal(true).optional(),
  idempotency_key: z.string().min(1).max(128).optional(),
  lease_id: FlaxId.optional(),
}).strict().superRefine((value, ctx) => { exactlyOneSelector(value, ctx); requiresConfirmation(value, ctx); });

function graphError(error: unknown): ToolDomainError {
  return mapBridgeError(error);
}

async function graphCall(
  ctx: ProjectMeta,
  method: BridgeMethod,
  params: Record<string, unknown>,
  changes: unknown[] = [],
  minimumBridgeVersion = 16,
): Promise<ToolResponse> {
  // A bridge-opened window needs frames before VisjectSurfaceWindow.Update()
  // runs LoadSurface(). The bridge keeps the window open and reports
  // INVALID_STATE + details.NotReady; retry here so
  // callers never hand-pump retries. Bounded: 5 attempts, ~9s max.
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await callEditorBridge(ctx, method, params, { minimumBridgeVersion });
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
    IncludeSubcontexts: args.include_subcontexts,
    MaxDepth: args.max_depth,
  }, [], args.include_subcontexts ? 19 : 16);

export const handleGraphSetDefaultParameter = (args: z.infer<typeof GraphSetDefaultParameterSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.set_default_parameter', {
    ...selector(args),
    ParameterId: args.parameter_id,
    ParameterName: args.parameter_name,
    Value: toBridgeValue(args.value),
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
    LeaseId: args.lease_id,
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
    LeaseId: args.lease_id,
  }, args.dry_run ? [] : [{ kind: 'graph-parameter', asset_id: args.asset_id, path: args.path }]);

export const handleGraphUndo = (args: z.infer<typeof GraphUndoSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.undo', { ...selector(args) });

export const handleGraphRemoveNode = (args: z.infer<typeof GraphRemoveNodeSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.remove_node', {
    ...selector(args),
    NodeId: args.node_id,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
    LeaseId: args.lease_id,
  }, args.dry_run ? [] : [{ kind: 'graph-node', asset_id: args.asset_id, path: args.path }], 18);

export const handleGraphDisconnect = (args: z.infer<typeof GraphDisconnectSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.disconnect', {
    ...selector(args),
    FromNode: args.from_node,
    FromBox: args.from_box,
    ToNode: args.to_node,
    ToBox: args.to_box,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
    LeaseId: args.lease_id,
  }, args.dry_run ? [] : [{ kind: 'graph-wire', asset_id: args.asset_id, path: args.path }], 18);

export const handleGraphSetNodeValues = (args: z.infer<typeof GraphSetNodeValuesSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.set_node_values', {
    ...selector(args),
    NodeId: args.node_id,
    Values: args.values.map(entry => ({ Index: entry.index, Value: toBridgeValue(entry.value) })),
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
    LeaseId: args.lease_id,
  }, args.dry_run ? [] : [{ kind: 'graph-node-values', asset_id: args.asset_id, path: args.path }], 20);

export const handleGraphMoveNode = (args: z.infer<typeof GraphMoveNodeSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'graph.move_node', {
    ...selector(args),
    NodeId: args.node_id,
    X: args.x,
    Y: args.y,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
    LeaseId: args.lease_id,
  }, args.dry_run ? [] : [{ kind: 'graph-node-move', asset_id: args.asset_id, path: args.path }], 20);

export const handleAnimgraphSetStateClip = (args: z.infer<typeof AnimgraphSetStateClipSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'animgraph.set_state_clip', {
    ...selector(args),
    State: args.state,
    ClipAssetId: args.clip_asset_id,
    ClipPath: args.clip_path,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
    LeaseId: args.lease_id,
  }, args.dry_run ? [] : [{ kind: 'animgraph-clip', asset_id: args.asset_id, path: args.path }], 20);

export const handleAnimgraphAddState = (args: z.infer<typeof AnimgraphAddStateSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'animgraph.add_state', {
    ...selector(args),
    Name: args.name,
    X: args.x,
    Y: args.y,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
    LeaseId: args.lease_id,
  }, args.dry_run ? [] : [{ kind: 'animgraph-state', asset_id: args.asset_id, path: args.path }], 17);

export const handleAnimgraphAddTransition = (args: z.infer<typeof AnimgraphAddTransitionSchema>, ctx: ProjectMeta) =>
  graphCall(ctx, 'animgraph.add_transition', {
    ...selector(args),
    FromState: args.from_state,
    ToState: args.to_state,
    DryRun: args.dry_run,
    Confirm: args.confirm === true,
    IdempotencyKey: args.idempotency_key,
    LeaseId: args.lease_id,
  }, args.dry_run ? [] : [{ kind: 'animgraph-transition', asset_id: args.asset_id, path: args.path }], 17);

function toBridgeValue(value: unknown): unknown {
  if (typeof value === 'boolean') return { Kind: 'boolean', Boolean: value };
  if (typeof value === 'number') return { Kind: 'number', Number: value };
  if (typeof value === 'string') return { Kind: 'string', Text: value };
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.asset_id === 'string') return { Kind: 'asset_id', AssetId: record.asset_id };
    const numeric = record as Record<string, number>;
    if (typeof numeric.w === 'number') return { Kind: 'vector4', Vector4: { X: numeric.x, Y: numeric.y, Z: numeric.z, W: numeric.w } };
    if (typeof numeric.z === 'number') return { Kind: 'vector3', Vector3: { X: numeric.x, Y: numeric.y, Z: numeric.z } };
    return { Kind: 'vector2', Vector2: { X: numeric.x, Y: numeric.y } };
  }
  return value;
}
