import { ToolDomainError } from '../errors.js';
import { BridgeRpcError } from './protocol.js';

/**
 * True when a remote INVALID_STATE was raised because the Editor runs
 * headless: "headless" in the remote error message or in its serialized
 * details. Surface-specific mappers that give INVALID_STATE another meaning
 * (a wrong play state) use this to keep the two apart.
 */
export function isHeadlessRefusal(error: BridgeRpcError): boolean {
  let serialized = '';
  try {
    serialized = JSON.stringify(error.details) ?? '';
  } catch {
    serialized = String(error.details);
  }
  return /headless/i.test(error.message) || /headless/i.test(serialized);
}

/**
 * Shared bridge→tool error mapper (P2a).
 *
 * Consolidates the previously duplicated graphError()/mmError() logic so both
 * graph and MM surfaces map the full BridgeRpcError contract identically:
 * concurrent-call, lease trio, idempotency reuse, METHOD_NOT_ALLOWED, and
 * headless INVALID_STATE are covered in one place.
 *
 * Notes:
 * - ToolDomainError inputs pass through unchanged (preserves the old mmError
 *   behavior now that mmError() delegates here).
 * - INVALID_STATE carrying headless evidence maps to HEADLESS_MODE (a new
 *   ToolErrorCode placed next to CAPTURE_UNAVAILABLE); any other
 *   INVALID_STATE maps to EDITOR_BUSY. Headless is detected from the
 *   remote error message or the serialized BridgeRpcError details. The
 *   bridge raises every headless refusal (RequireEditTime, graph
 *   inspect/edit/undo, editor selection, capture, play start) as
 *   INVALID_STATE with "headless" in the message and no details, and only
 *   when the Editor is headless, so the message is the evidence a real
 *   Editor sends. HEADLESS_MODE tells the caller a retry cannot help;
 *   EDITOR_BUSY invites one. Surfaces with their own mapper (domainLive,
 *   mmTuning, runtimeLive) call isHeadlessRefusal for the same split; only
 *   viewport_capture keeps CAPTURE_UNAVAILABLE for a headless Editor, the
 *   code it uses for every reason a capture cannot be taken. The graph retry-glue
 *   (graphNotReadyDelay/graphCall) is untouched: NotReady retries still
 *   happen before this mapper runs.
 */
export function mapBridgeError(error: unknown): ToolDomainError {
  if (error instanceof ToolDomainError) return error;
  if (!(error instanceof BridgeRpcError)) {
    return new ToolDomainError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }
  if (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED') {
    return new ToolDomainError('EDITOR_NOT_CONNECTED', error.message, error.details);
  }
  if (error.code === 'BRIDGE_CONCURRENT_CALL') return new ToolDomainError('EDITOR_BUSY', error.message, error.details);
  if (error.code === 'BRIDGE_TIMEOUT') return new ToolDomainError('TIMEOUT', error.message, error.details);
  if (error.code === 'BRIDGE_UNSUPPORTED') {
    return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, error.details);
  }
  if (error.code === 'BRIDGE_REMOTE_ERROR') {
    const remote = error.details as { code?: unknown; details?: unknown } | undefined;
    const code = remote?.code;
    const details = remote?.details;
    if (code === 'ASSET_NOT_FOUND') return new ToolDomainError('ASSET_NOT_FOUND', error.message, details);
    if (code === 'NOT_FOUND') return new ToolDomainError('NOT_FOUND', error.message, details);
    if (code === 'EDITOR_BUSY') return new ToolDomainError('EDITOR_BUSY', error.message, details);
    if (code === 'INVALID_STATE') {
      if (isHeadlessRefusal(error)) return new ToolDomainError('HEADLESS_MODE', error.message, details);
      return new ToolDomainError('EDITOR_BUSY', error.message, details);
    }
    if (code === 'UNAUTHORIZED') {
      // The session token rotated: the Editor reloaded scripts, or a different Editor answered this
      // project's bridge. A read can simply be repeated; a write must not be retried automatically
      // (it may or may not have run), so callers decide using idempotency keys or a re-read.
      return new ToolDomainError('EDITOR_BUSY', error.message, { retryable: true, reason: 'bridge_session_changed', details });
    }
    if (code === 'IMPORT_SOURCE_NOT_ALLOWED' || code === 'IMPORT_FAILED' || code === 'FILE_EXISTS' || code === 'OPERATION_NOT_FOUND') {
      return new ToolDomainError(code, error.message, details);
    }
    if (code === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, details);
    if (code === 'REQUEST_TOO_LARGE' || code === 'RESPONSE_TOO_LARGE') {
      return new ToolDomainError('CONTENT_TOO_LARGE', error.message, details);
    }
    if (code === 'METHOD_NOT_ALLOWED' || code === 'METHOD_NOT_FOUND') {
      return new ToolDomainError(
        'UNSUPPORTED_FLAX_VERSION',
        `${error.message} (capability: check bridge status/PROTOCOL for supported methods)`,
        details,
      );
    }
    if (code === 'UNSUPPORTED_FLAX_VERSION') {
      return new ToolDomainError('UNSUPPORTED_FLAX_VERSION', error.message, details);
    }
    if (code === 'IDEMPOTENCY_KEY_REUSED') {
      return new ToolDomainError('IDEMPOTENCY_KEY_REUSED', error.message, details);
    }
    if (code === 'EDIT_LEASE_CONFLICT') return new ToolDomainError('EDIT_LEASE_CONFLICT', error.message, details);
    if (code === 'EDIT_LEASE_EXPIRED') return new ToolDomainError('EDIT_LEASE_EXPIRED', error.message, details);
    if (code === 'EDIT_LEASE_ACTIVE') return new ToolDomainError('EDIT_LEASE_ACTIVE', error.message, details);
    if (code === 'DIRTY_SCENE') return new ToolDomainError('DIRTY_SCENES', error.message, details);
    if (code === 'ASSET_OPERATION_FAILED') return new ToolDomainError('ASSET_OPERATION_FAILED', error.message, details);
    if (code === 'INVALID_REQUEST' || code === 'VALIDATION_FAILED') {
      return new ToolDomainError('VALIDATION_FAILED', error.message, details);
    }
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}

/**
 * Error mapper for calls to a runtime (cooked game) bridge (v35). A game that is not running, whose
 * heartbeat is stale, or whose session token is gone is GAME_NOT_CONNECTED (the game counterpart of
 * EDITOR_NOT_CONNECTED); everything else maps exactly like the editor bridge. A cooked game has no
 * play state, so INVALID_STATE keeps the shared EDITOR_BUSY meaning ("retry later").
 */
export function mapRuntimeBridgeError(error: unknown): ToolDomainError {
  if (error instanceof BridgeRpcError && (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_AUTH_FAILED')) {
    return new ToolDomainError('GAME_NOT_CONNECTED', error.message, error.details);
  }
  return mapBridgeError(error);
}
