/**
 * File-RPC protocol shared with the Flax Editor Bridge.
 *
 * Every path is rooted at <project>/Cache/MCP. The editor owns bridge.json and
 * token; Node owns request files; the editor owns response files. Both sides
 * publish JSON atomically by renaming a fully written temporary file.
 */
export const BRIDGE_CACHE_DIRECTORY = 'Cache/MCP';
export const BRIDGE_HEARTBEAT_FILE = 'bridge.json';
export const BRIDGE_TOKEN_FILE = 'token';
export const BRIDGE_REQUESTS_DIRECTORY = 'requests';
export const BRIDGE_RESPONSES_DIRECTORY = 'responses';

export type SceneBridgeMethod =
  | 'scene.list_loaded'
  | 'scene.get_tree'
  | 'scene.save'
  | 'project.save_all';

export type ActorBridgeMethod =
  | 'actor.get'
  | 'actor.find'
  | 'actor.validate_create'
  | 'actor.create'
  | 'actor.update'
  | 'actor.delete'
  | 'actor.duplicate'
  | 'actor.reparent';

export type ScriptBridgeMethod =
  | 'script.attach'
  | 'script.detach'
  | 'script.instance_get'
  | 'script.instance_update';

export type EditBridgeMethod =
  | 'edit.undo'
  | 'edit.redo'
  | 'edit.lease_begin'
  | 'edit.lease_get'
  | 'edit.lease_commit'
  | 'edit.lease_release';

export type CodeBridgeMethod =
  | 'code.status'
  | 'code.compile_start'
  | 'code.diagnostics'
  | 'code.generate_project_start'
  | 'code.generate_project_status';

export type PlayBridgeMethod =
  | 'play.status'
  | 'play.start_scenes'
  | 'play.start_game'
  | 'play.stop'
  | 'play.pause'
  | 'play.resume'
  | 'play.step';

export type ObservabilityBridgeMethod =
  | 'log.query'
  | 'capture.start'
  | 'capture.status'
  | 'runtime.inspect_actor';

export type AssetBridgeMethod =
  | 'asset.search'
  | 'asset.get'
  | 'asset.dependencies'
  | 'asset.find_references'
  | 'asset.import_start'
  | 'asset.import_status'
  | 'asset.reimport_start'
  | 'asset.reimport_status'
  | 'asset.move'
  | 'asset.rename'
  | 'asset.duplicate'
  | 'asset.delete';

/**
 * Bridge v11 exposes raw, persisted operation handles. This deliberately is
 * not MCP Tasks: callers poll or cancel an operation by its exact ID.
 */
export type OperationBridgeMethod =
  | 'operation.status'
  | 'operation.cancel';

/** Additive bridge v12 prefab workflows backed by verified Flax 1.12 APIs. */
export type PrefabBridgeMethod =
  | 'prefab.create_from_actor'
  | 'prefab.instantiate'
  | 'prefab.get_instances'
  | 'prefab.get_overrides'
  | 'prefab.apply_overrides'
  | 'prefab.revert_overrides'
  | 'prefab.break_link';

/** Bridge v13 exposes bounded GameCooker workflows, not arbitrary build commands. */
export type BuildBridgeMethod =
  | 'build.list_targets'
  | 'build.validate'
  | 'build.cook'
  | 'build.status'
  | 'build.result'
  | 'build.cancel';

/** Additive bridge v13 material and animation inspection surface. */
export type MaterialBridgeMethod =
  | 'material.get_parameters'
  | 'material.set_parameters'
  | 'material.create_instance'
  | 'material.assign_to_actor';

export type AnimationBridgeMethod =
  | 'animation.list_clips'
  | 'animation.get_graph_parameters'
  | 'animation.set_graph_parameter'
  | 'animation.validate_bindings';

export type BridgeMethod =
  | 'status'
  | SceneBridgeMethod
  | ActorBridgeMethod
  | ScriptBridgeMethod
  | EditBridgeMethod
  | CodeBridgeMethod
  | PlayBridgeMethod
  | ObservabilityBridgeMethod
  | AssetBridgeMethod
  | OperationBridgeMethod
  | PrefabBridgeMethod
  | BuildBridgeMethod
  | MaterialBridgeMethod
  | AnimationBridgeMethod;

/** Exact on-disk DTO written to requests/<id>.json by the Node client. */
export interface BridgeRequest<M extends BridgeMethod = BridgeMethod> {
  id: string;
  token: string;
  method: M;
  paramsJson: string;
  deadlineUnixMs: number;
}

export interface BridgeRemoteError {
  code: string;
  message: string;
  details?: unknown;
}

/** Exact on-disk DTO written to responses/<id>.json by the editor bridge. */
export interface BridgeResponse {
  id: string;
  token: string;
  ok: boolean;
  errorCode?: string;
  error?: string;
  /** Optional JSON string containing structured bridge error details (v7+). */
  errorDetails?: string | null;
  resultJson?: string | null;
  timestamp?: string | number;
}

export interface BridgeCallResult<R = unknown> {
  result: R;
  warnings: string[];
  bridge: BridgeConnectionMetadata;
}

export interface BridgeConnectionMetadata {
  connected: true;
  reason: 'connected';
  pid: number | null;
  heartbeatAgeMs: number | null;
  editorVersion: string | null;
  bridgeVersion: string | null;
  protocolVersion: string | null;
  endpoint: string | null;
}

export type BridgeErrorCode =
  | 'BRIDGE_UNAVAILABLE'
  | 'BRIDGE_AUTH_FAILED'
  | 'BRIDGE_UNSUPPORTED'
  | 'BRIDGE_CONCURRENT_CALL'
  | 'BRIDGE_TIMEOUT'
  | 'BRIDGE_PROTOCOL_ERROR'
  | 'BRIDGE_RESPONSE_INVALID'
  | 'BRIDGE_MESSAGE_TOO_LARGE'
  | 'BRIDGE_REMOTE_ERROR';

/** Stable, bridge-specific errors for later conversion to MCP domain errors. */
export class BridgeRpcError extends Error {
  constructor(
    public readonly code: BridgeErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'BridgeRpcError';
  }
}
