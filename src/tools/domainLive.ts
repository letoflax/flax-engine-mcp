import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { isHeadlessRefusal } from '../bridge/mapBridgeError.js';
import { BridgeRpcError, type BridgeMethod } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, type ToolResponse } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';

const Vector3 = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const LayerMask = z.number().int().min(0).max(0xffff_ffff).optional().default(0xffff_ffff);
const ActorIdHex = z.string().regex(/^[a-fA-F0-9]{32}$/, 'actor id must be a 32-character hex GUID.');
const SceneIdHex = z.string().regex(/^[a-fA-F0-9]{32}$/, 'scene id must be a 32-character hex GUID.');
const BoundsTriple = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const PhysicsValidateCollidersSchema = z.object({}).strict();
export const PhysicsRaycastSchema = z.object({ origin: Vector3, direction: Vector3, distance: z.number().finite().positive().max(100_000).optional().default(1000), layer_mask: LayerMask, include_triggers: z.boolean().optional().default(true) }).strict();
export const PhysicsGetLayerMatrixSchema = z.object({}).strict();
export const PhysicsFindOverlapsSchema = z.object({ center: Vector3, radius: z.number().finite().positive().max(100_000), layer_mask: LayerMask, include_triggers: z.boolean().optional().default(true), limit: z.number().int().min(1).max(100).optional().default(50) }).strict();
// Bridge v31 replaces the stable-unsupported navigation stub with a real
// BuildNavMesh + poll implementation. Bounds default to the whole scene.
export const NavigationBuildSchema = z.object({
  scene_id: SceneIdHex.optional(),
  bounds: z.object({ min: BoundsTriple, max: BoundsTriple }).strict().optional(),
  timeout_ms: z.number().int().min(500).max(60_000).optional().default(15_000),
}).strict().superRefine((value, ctx) => {
  if (value.bounds && (value.bounds.min[0] > value.bounds.max[0] || value.bounds.min[1] > value.bounds.max[1] || value.bounds.min[2] > value.bounds.max[2])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bounds min must not exceed max on any axis.', path: ['bounds'] });
  }
});
export const NavigationGetStatusSchema = z.object({}).strict();
export const NavigationValidateAgentsSchema = z.object({}).strict();
export const NavigationQueryPathSchema = z.object({ start: Vector3, end: Vector3, max_points: z.number().int().min(1).max(256).optional().default(128) }).strict();
// Bridge v31 replaces the stable-unsupported lightmap stub with the
// BakeLightmapsOrCancel toggle plus LightmapsBakeProgress/End event state.
// Start returns phase baking; the caller polls status for step progress.
export const LightingBakeSchema = z.object({
  action: z.enum(['start', 'cancel', 'status']).optional().default('status'),
}).strict();
export const LightingGetStatusSchema = z.object({}).strict();
export const LightingValidateSchema = z.object({}).strict();
// Bridge v31 replaces the stable-unsupported probe stub with Bake plus a
// HasContentLoaded poll. Bake takes seconds server-side; the poll budget here
// is timeout_ms milliseconds. No progress or cancel API exists.
export const EnvironmentProbeBakeSchema = z.object({
  actor_id: ActorIdHex,
  timeout_ms: z.number().int().min(1000).max(60_000).optional().default(10_000),
}).strict();
export const TerrainGetSummarySchema = z.object({ limit: z.number().int().min(1).max(100).optional().default(100) }).strict();
export const FoliageGetSummarySchema = TerrainGetSummarySchema;
// Bridge v31 keeps terrain.paint a validated stub: Flax 1.12 terrain data
// accessors return raw pointers (unsafe context required, not verified for
// Flax script compilation) and the EditTerrain* undo actions are internal
// editor types with no public factory. Node still enforces the full rect
// contract, then maps the bridge UNSUPPORTED_FLAX_VERSION honestly.
export const TerrainPaintSchema = z.object({
  terrain_id: ActorIdHex,
  patch_index: z.number().int().min(0).max(100_000).optional().default(0),
  mode: z.enum(['height', 'splat', 'holes']),
  offset_x: z.number().int().min(0).max(100_000),
  offset_y: z.number().int().min(0).max(100_000),
  size_w: z.number().int().min(1).max(16_384),
  size_h: z.number().int().min(1).max(16_384),
  values: z.array(z.number().finite()).min(1).max(16_384),
  dry_run: z.boolean().optional().default(false),
}).strict().superRefine((value, ctx) => {
  const cells = value.size_w * value.size_h;
  if (cells > 16_384) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Paint rect budget exceeded: size_w*size_h must be at most 128*128 (16384).', path: ['size_w'] });
  }
  if (value.values.length !== cells) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `values must contain exactly size_w*size_h (${cells}) numbers, got ${value.values.length}.`, path: ['values'] });
  }
});
// Bridge v31 foliage writes. Positions are local-space relative to the
// foliage actor (FoliageInstance.Transform); rotation is pitch/yaw/roll
// degrees via Quaternion.Euler; scale is uniform. One RebuildClusters plus
// UpdateCullDistance runs after each batch (no progress/cancel API exists,
// hence the 200 cap).
const FoliageInstanceSpec = z.object({
  position: BoundsTriple,
  rotation: BoundsTriple.optional().default([0, 0, 0]),
  scale: z.number().finite().positive().max(10_000).optional().default(1),
}).strict();
export const FoliageAddInstancesSchema = z.object({
  foliage_id: ActorIdHex,
  type_index: z.number().int().min(0).max(1024).optional().default(0),
  instances: z.array(FoliageInstanceSpec).min(1).max(200),
}).strict();
export const FoliageRemoveInstancesSchema = z.object({
  foliage_id: ActorIdHex,
  instance_indices: z.array(z.number().int().min(0).max(1_000_000)).min(1).max(200),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.instance_indices).size !== value.instance_indices.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'instance_indices must not contain duplicates.', path: ['instance_indices'] });
  }
});

function domainError(error: unknown): ToolDomainError {
  if (error instanceof ToolDomainError) return error;
  if (!(error instanceof BridgeRpcError)) return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  const remote = error.details as { code?: unknown; details?: unknown } | undefined;
  if (remote?.code === 'UNSUPPORTED_FLAX_VERSION') return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, remote.details);
  if (remote?.code === 'INVALID_REQUEST' || remote?.code === 'VALIDATION_FAILED') return new ToolDomainError('VALIDATION_FAILED', error.message, remote.details);
  if (remote?.code === 'NOT_FOUND') return new ToolDomainError('NOT_FOUND', error.message, remote.details);
  if (remote?.code === 'TIMEOUT' || remote?.code === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, remote.details);
  if (remote?.code === 'INVALID_STATE') {
    if (isHeadlessRefusal(error)) return new ToolDomainError('HEADLESS_MODE', error.message, remote.details);
    return new ToolDomainError('INVALID_PLAY_STATE', error.message, remote.details);
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}
const vector = (value: z.infer<typeof Vector3>) => ({ X: value.x, Y: value.y, Z: value.z });
const triple = (value: readonly [number, number, number]) => ({ X: value[0], Y: value[1], Z: value[2] });
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {}; }
function bridgeWarnings(value: unknown): string[] {
  const warnings = record(value).Warnings ?? record(value).warnings;
  return Array.isArray(warnings) ? warnings.filter((entry): entry is string => typeof entry === 'string') : [];
}

async function query(ctx: ProjectMeta, method: BridgeMethod, params: Record<string, unknown> = {}, minimumBridgeVersion = 14, deadlineMs?: number): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, method, params, { minimumBridgeVersion, ...(deadlineMs === undefined ? {} : { deadlineMs }) });
    const data = { result: response.data, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings: response.warnings });
  } catch (error) { return toolError(domainError(error)); }
}

function success(data: unknown, bridge: unknown, warnings: string[] = [], changes: unknown[] = []): ToolResponse {
  return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings, changes });
}

export const handlePhysicsValidateColliders = (_: z.infer<typeof PhysicsValidateCollidersSchema>, ctx: ProjectMeta) => query(ctx, 'physics.validate_colliders');
export const handlePhysicsRaycast = (args: z.infer<typeof PhysicsRaycastSchema>, ctx: ProjectMeta) => query(ctx, 'physics.raycast', { Origin: vector(args.origin), Direction: vector(args.direction), Distance: args.distance, LayerMask: args.layer_mask, IncludeTriggers: args.include_triggers });
export const handlePhysicsGetLayerMatrix = (_: z.infer<typeof PhysicsGetLayerMatrixSchema>, ctx: ProjectMeta) => query(ctx, 'physics.get_layer_matrix');
export const handlePhysicsFindOverlaps = (args: z.infer<typeof PhysicsFindOverlapsSchema>, ctx: ProjectMeta) => query(ctx, 'physics.find_overlaps', { Center: vector(args.center), Radius: args.radius, LayerMask: args.layer_mask, IncludeTriggers: args.include_triggers, Limit: args.limit });
export async function handleNavigationBuild(args: z.infer<typeof NavigationBuildSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const warnings: string[] = [];
    if (!args.bounds) warnings.push('No bounds given: whole-scene build discards all tiles of the target scene(s) and may take a while; prefer bounds for iterative work.');
    const response = await callEditorBridge(ctx, 'navigation.build', {
      SceneId: args.scene_id ?? null,
      Min: args.bounds ? triple(args.bounds.min) : null,
      Max: args.bounds ? triple(args.bounds.max) : null,
      TimeoutMs: args.timeout_ms,
    }, { minimumBridgeVersion: 31, deadlineMs: Math.min(60_000, args.timeout_ms + 5_000) });
    const data = record(response.data);
    warnings.push(...response.warnings, ...bridgeWarnings(response.data));
    if ((data.Phase ?? data.phase) === 'timeout') {
      return toolError(new ToolDomainError('TIMEOUT', `Navmesh build did not finish within timeout_ms (${args.timeout_ms}). The build continues in the background (Flax 1.12 exposes no navmesh cancel API); poll navigation_get_status for progress.`, {
        phase: 'timeout',
        progress: data.Progress ?? data.progress ?? null,
        sceneId: data.SceneId ?? data.sceneId ?? null,
      }));
    }
    return success({ result: response.data, bridge: response.bridge }, response.bridge, warnings,
      [{ kind: 'navigation.build.completed', phase: data.Phase ?? data.phase ?? 'completed' }]);
  } catch (error) { return toolError(domainError(error)); }
}
export const handleNavigationGetStatus = (_: z.infer<typeof NavigationGetStatusSchema>, ctx: ProjectMeta) => query(ctx, 'navigation.get_status');
export const handleNavigationValidateAgents = (_: z.infer<typeof NavigationValidateAgentsSchema>, ctx: ProjectMeta) => query(ctx, 'navigation.validate_agents');
export const handleNavigationQueryPath = (args: z.infer<typeof NavigationQueryPathSchema>, ctx: ProjectMeta) => query(ctx, 'navigation.query_path', { Start: vector(args.start), End: vector(args.end), MaxPoints: args.max_points });
export async function handleLightingBake(args: z.infer<typeof LightingBakeSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, 'lighting.bake', { Action: args.action }, { minimumBridgeVersion: 31 });
    const data = record(response.data);
    const warnings = [...response.warnings, ...bridgeWarnings(response.data)];
    if (args.action === 'start') warnings.push('Bake started (phase baking); poll lighting_bake status for step progress. LightmapsBakeEnd(failed:true) conflates bake failure and cancellation.');
    return success({ result: response.data, bridge: response.bridge }, response.bridge, warnings,
      args.action === 'status' ? [] : [{ kind: 'lighting.bake.requested', action: args.action, phase: data.Phase ?? data.phase ?? null }]);
  } catch (error) { return toolError(domainError(error)); }
}
export const handleLightingGetStatus = (_: z.infer<typeof LightingGetStatusSchema>, ctx: ProjectMeta) => query(ctx, 'lighting.get_status');
export const handleLightingValidate = (_: z.infer<typeof LightingValidateSchema>, ctx: ProjectMeta) => query(ctx, 'lighting.validate');
export async function handleEnvironmentProbeBake(args: z.infer<typeof EnvironmentProbeBakeSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, 'environment_probe.bake', {
      ActorId: args.actor_id,
      TimeoutMs: args.timeout_ms,
    }, { minimumBridgeVersion: 31, deadlineMs: Math.min(60_000, args.timeout_ms + 5_000) });
    const data = record(response.data);
    const warnings = [...response.warnings, ...bridgeWarnings(response.data)];
    if ((data.Phase ?? data.phase) === 'timeout') {
      return toolError(new ToolDomainError('TIMEOUT', `Probe bake did not report loaded content within timeout_ms (${args.timeout_ms}). The bake may still complete in the background (no cancel API); baked output persists via scene save by the user.`, {
        phase: 'timeout',
        actorId: data.ActorId ?? data.actorId ?? args.actor_id,
      }));
    }
    return success({ result: response.data, bridge: response.bridge }, response.bridge, warnings,
      [{ kind: 'environment_probe.bake.completed', actorId: data.ActorId ?? data.actorId ?? args.actor_id }]);
  } catch (error) { return toolError(domainError(error)); }
}
export const handleTerrainGetSummary = (args: z.infer<typeof TerrainGetSummarySchema>, ctx: ProjectMeta) => query(ctx, 'terrain.get_summary', { Limit: args.limit });
export const handleFoliageGetSummary = (args: z.infer<typeof FoliageGetSummarySchema>, ctx: ProjectMeta) => query(ctx, 'foliage.get_summary', { Limit: args.limit });
export async function handleTerrainPaint(args: z.infer<typeof TerrainPaintSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  // Validated stub (bridge v31): schemas enforce the rect budget and value
  // arity, then the bridge reports the stable unsupported capability.
  try {
    const response = await callEditorBridge(ctx, 'terrain.paint', {
      TerrainId: args.terrain_id,
      PatchIndex: args.patch_index,
      Mode: args.mode,
      OffsetX: args.offset_x,
      OffsetY: args.offset_y,
      SizeW: args.size_w,
      SizeH: args.size_h,
      Values: args.values,
      DryRun: args.dry_run,
    }, { minimumBridgeVersion: 31 });
    return success({ result: response.data, bridge: response.bridge }, response.bridge, response.warnings);
  } catch (error) { return toolError(domainError(error)); }
}
export async function handleFoliageAddInstances(args: z.infer<typeof FoliageAddInstancesSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, 'foliage.add_instances', {
      FoliageId: args.foliage_id,
      TypeIndex: args.type_index,
      Instances: args.instances.map(entry => ({ Position: triple(entry.position), Rotation: triple(entry.rotation), Scale: entry.scale })),
    }, { minimumBridgeVersion: 31 });
    const data = record(response.data);
    return success({ result: response.data, bridge: response.bridge }, response.bridge,
      [...response.warnings, ...bridgeWarnings(response.data)],
      [{ kind: 'foliage.instances_added', foliageId: args.foliage_id, added: data.AddedCount ?? data.addedCount ?? args.instances.length }]);
  } catch (error) { return toolError(domainError(error)); }
}
export async function handleFoliageRemoveInstances(args: z.infer<typeof FoliageRemoveInstancesSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, 'foliage.remove_instances', {
      FoliageId: args.foliage_id,
      InstanceIndices: args.instance_indices,
    }, { minimumBridgeVersion: 31 });
    const data = record(response.data);
    return success({ result: response.data, bridge: response.bridge }, response.bridge,
      [...response.warnings, ...bridgeWarnings(response.data)],
      [{ kind: 'foliage.instances_removed', foliageId: args.foliage_id, removed: data.RemovedCount ?? data.removedCount ?? args.instance_indices.length }]);
  } catch (error) { return toolError(domainError(error)); }
}
