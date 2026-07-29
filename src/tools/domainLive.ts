import { z } from 'zod';
import { callEditorBridge } from '../bridge/fileRpcClient.js';
import { BridgeRpcError, type BridgeMethod } from '../bridge/protocol.js';
import { ToolDomainError, toolError, toolResult, type ToolResponse } from '../errors.js';
import type { ProjectMeta } from '../projectContext.js';

const Vector3 = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const LayerMask = z.number().int().min(0).max(0xffff_ffff).optional().default(0xffff_ffff);
export const PhysicsValidateCollidersSchema = z.object({}).strict();
export const PhysicsRaycastSchema = z.object({ origin: Vector3, direction: Vector3, distance: z.number().finite().positive().max(100_000).optional().default(1000), layer_mask: LayerMask, include_triggers: z.boolean().optional().default(true) }).strict();
export const PhysicsGetLayerMatrixSchema = z.object({}).strict();
export const PhysicsFindOverlapsSchema = z.object({ center: Vector3, radius: z.number().finite().positive().max(100_000), layer_mask: LayerMask, include_triggers: z.boolean().optional().default(true), limit: z.number().int().min(1).max(100).optional().default(50) }).strict();
export const NavigationBuildSchema = z.object({}).strict();
export const NavigationGetStatusSchema = z.object({}).strict();
export const NavigationValidateAgentsSchema = z.object({}).strict();
export const NavigationQueryPathSchema = z.object({ start: Vector3, end: Vector3, max_points: z.number().int().min(1).max(256).optional().default(128) }).strict();
export const LightingBakeSchema = z.object({}).strict();
export const LightingGetStatusSchema = z.object({}).strict();
export const LightingValidateSchema = z.object({}).strict();
export const EnvironmentProbeBakeSchema = z.object({}).strict();
export const TerrainGetSummarySchema = z.object({ limit: z.number().int().min(1).max(100).optional().default(100) }).strict();
export const FoliageGetSummarySchema = TerrainGetSummarySchema;

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
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}
const vector = (value: z.infer<typeof Vector3>) => ({ X: value.x, Y: value.y, Z: value.z });
async function query(ctx: ProjectMeta, method: BridgeMethod, params: Record<string, unknown> = {}): Promise<ToolResponse> {
  try {
    const response = await callEditorBridge(ctx, method, params, { minimumBridgeVersion: 14 });
    const data = { result: response.data, bridge: response.bridge };
    return toolResult(JSON.stringify(data, null, 2), { mode: 'editor-connected', data, warnings: response.warnings });
  } catch (error) { return toolError(domainError(error)); }
}

export const handlePhysicsValidateColliders = (_: z.infer<typeof PhysicsValidateCollidersSchema>, ctx: ProjectMeta) => query(ctx, 'physics.validate_colliders');
export const handlePhysicsRaycast = (args: z.infer<typeof PhysicsRaycastSchema>, ctx: ProjectMeta) => query(ctx, 'physics.raycast', { Origin: vector(args.origin), Direction: vector(args.direction), Distance: args.distance, LayerMask: args.layer_mask, IncludeTriggers: args.include_triggers });
export const handlePhysicsGetLayerMatrix = (_: z.infer<typeof PhysicsGetLayerMatrixSchema>, ctx: ProjectMeta) => query(ctx, 'physics.get_layer_matrix');
export const handlePhysicsFindOverlaps = (args: z.infer<typeof PhysicsFindOverlapsSchema>, ctx: ProjectMeta) => query(ctx, 'physics.find_overlaps', { Center: vector(args.center), Radius: args.radius, LayerMask: args.layer_mask, IncludeTriggers: args.include_triggers, Limit: args.limit });
export const handleNavigationBuild = (_: z.infer<typeof NavigationBuildSchema>, ctx: ProjectMeta) => query(ctx, 'navigation.build');
export const handleNavigationGetStatus = (_: z.infer<typeof NavigationGetStatusSchema>, ctx: ProjectMeta) => query(ctx, 'navigation.get_status');
export const handleNavigationValidateAgents = (_: z.infer<typeof NavigationValidateAgentsSchema>, ctx: ProjectMeta) => query(ctx, 'navigation.validate_agents');
export const handleNavigationQueryPath = (args: z.infer<typeof NavigationQueryPathSchema>, ctx: ProjectMeta) => query(ctx, 'navigation.query_path', { Start: vector(args.start), End: vector(args.end), MaxPoints: args.max_points });
export const handleLightingBake = (_: z.infer<typeof LightingBakeSchema>, ctx: ProjectMeta) => query(ctx, 'lighting.bake');
export const handleLightingGetStatus = (_: z.infer<typeof LightingGetStatusSchema>, ctx: ProjectMeta) => query(ctx, 'lighting.get_status');
export const handleLightingValidate = (_: z.infer<typeof LightingValidateSchema>, ctx: ProjectMeta) => query(ctx, 'lighting.validate');
export const handleEnvironmentProbeBake = (_: z.infer<typeof EnvironmentProbeBakeSchema>, ctx: ProjectMeta) => query(ctx, 'environment_probe.bake');
export const handleTerrainGetSummary = (args: z.infer<typeof TerrainGetSummarySchema>, ctx: ProjectMeta) => query(ctx, 'terrain.get_summary', { Limit: args.limit });
export const handleFoliageGetSummary = (args: z.infer<typeof FoliageGetSummarySchema>, ctx: ProjectMeta) => query(ctx, 'foliage.get_summary', { Limit: args.limit });
