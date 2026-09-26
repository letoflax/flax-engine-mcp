import { ToolDomainError } from '../errors.js';
import { BridgeRpcError } from './protocol.js';

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
 *   serialized BridgeRpcError details only, not the message. The graph
 *   retry-glue (graphNotReadyDelay/graphCall) is untouched: NotReady retries
 *   still happen before this mapper runs.
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
      let serialized = '';
      try {
        serialized = JSON.stringify(error.details) ?? '';
      } catch {
        serialized = String(error.details);
      }
      if (/headless/i.test(serialized)) return new ToolDomainError('HEADLESS_MODE', error.message, details);
      return new ToolDomainError('EDITOR_BUSY', error.message, details);
    }
    if (code === 'DEADLINE_EXCEEDED') return new ToolDomainError('TIMEOUT', error.message, details);
    if (code === 'REQUEST_TOO_LARGE' || code === 'RESPONSE_TOO_LARGE') {
      return new ToolDomainError('CONTENT_TOO_LARGE', error.message, details);
    }
    if (code === 'METHOD_NOT_ALLOWED') {
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
    if (code === 'INVALID_REQUEST' || code === 'VALIDATION_FAILED') {
      return new ToolDomainError('VALIDATION_FAILED', error.message, details);
    }
  }
  return new ToolDomainError('INTERNAL_ERROR', error.message, { bridgeCode: error.code, details: error.details });
}
