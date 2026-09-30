import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolDomainError } from '../errors.js';
import { isHeadlessRefusal, mapBridgeError } from './mapBridgeError.js';
import { BridgeRpcError } from './protocol.js';

function remote(code: string, details?: unknown, message = `${code} from bridge.`): ToolDomainError {
  return mapBridgeError(new BridgeRpcError('BRIDGE_REMOTE_ERROR', message, { code, details }));
}

test('mapBridgeError keeps non-bridge failures as INTERNAL_ERROR', () => {
  assert.equal(mapBridgeError(new Error('boom')).code, 'INTERNAL_ERROR');
  assert.equal(mapBridgeError(new Error('boom')).message, 'boom');
  assert.equal(mapBridgeError('plain failure').code, 'INTERNAL_ERROR');
  assert.equal(mapBridgeError('plain failure').message, 'plain failure');
});

test('mapBridgeError passes ToolDomainError through unchanged', () => {
  const original = new ToolDomainError('NOT_FOUND', 'already mapped', { depth: 1 });
  assert.equal(mapBridgeError(original), original);
});

test('mapBridgeError maps transport failures', () => {
  assert.equal(mapBridgeError(new BridgeRpcError('BRIDGE_UNAVAILABLE', 'no bridge')).code, 'EDITOR_NOT_CONNECTED');
  assert.equal(mapBridgeError(new BridgeRpcError('BRIDGE_AUTH_FAILED', 'bad token')).code, 'EDITOR_NOT_CONNECTED');
  assert.equal(mapBridgeError(new BridgeRpcError('BRIDGE_CONCURRENT_CALL', 'busy')).code, 'EDITOR_BUSY');
  assert.equal(mapBridgeError(new BridgeRpcError('BRIDGE_TIMEOUT', 'slow')).code, 'TIMEOUT');
  assert.equal(mapBridgeError(new BridgeRpcError('BRIDGE_UNSUPPORTED', 'old')).code, 'UNSUPPORTED_FLAX_VERSION');
});

test('mapBridgeError maps not-found and deadline remote codes', () => {
  assert.equal(remote('ASSET_NOT_FOUND').code, 'ASSET_NOT_FOUND');
  assert.equal(remote('NOT_FOUND').code, 'NOT_FOUND');
  assert.equal(remote('DEADLINE_EXCEEDED').code, 'TIMEOUT');
});

test('mapBridgeError maps the edit-lease trio', () => {
  assert.equal(remote('EDIT_LEASE_CONFLICT').code, 'EDIT_LEASE_CONFLICT');
  assert.equal(remote('EDIT_LEASE_EXPIRED').code, 'EDIT_LEASE_EXPIRED');
  assert.equal(remote('EDIT_LEASE_ACTIVE').code, 'EDIT_LEASE_ACTIVE');
});

test('mapBridgeError maps idempotency reuse', () => {
  const mapped = remote('IDEMPOTENCY_KEY_REUSED');
  assert.equal(mapped.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('mapBridgeError maps validation and oversized payloads', () => {
  assert.equal(remote('VALIDATION_FAILED').code, 'VALIDATION_FAILED');
  assert.equal(remote('INVALID_REQUEST').code, 'VALIDATION_FAILED');
  assert.equal(remote('REQUEST_TOO_LARGE').code, 'CONTENT_TOO_LARGE');
  assert.equal(remote('RESPONSE_TOO_LARGE').code, 'CONTENT_TOO_LARGE');
});

test('mapBridgeError maps METHOD_NOT_ALLOWED to UNSUPPORTED_FLAX_VERSION with a capability hint', () => {
  const mapped = remote('METHOD_NOT_ALLOWED', { Method: 'mm.tuning' }, 'Method mm.tuning is not supported.');
  assert.equal(mapped.code, 'UNSUPPORTED_FLAX_VERSION');
  assert.match(mapped.message, /Method mm\.tuning is not supported\./);
  assert.match(mapped.message, /capability: check bridge status\/PROTOCOL for supported methods/);
  assert.deepEqual(mapped.details, { Method: 'mm.tuning' });
});

test('mapBridgeError splits headless INVALID_STATE from editor-busy INVALID_STATE', () => {
  const headless = remote('INVALID_STATE', { Reason: 'Headless editor has no GUI surface.' }, 'No surface.');
  assert.equal(headless.code, 'HEADLESS_MODE');
  assert.deepEqual(headless.details, { Reason: 'Headless editor has no GUI surface.' });

  const busy = remote('INVALID_STATE', { NotReady: false }, 'Still loading.');
  assert.equal(busy.code, 'EDITOR_BUSY');
});

test('mapBridgeError reads headless evidence from the remote message, which is all a real Editor sends', () => {
  // Every headless refusal in the bridge is INVALID_STATE with "headless" in
  // the message and no details (observed against a headless Flax 1.12 Editor).
  for (const message of [
    'material.set_parameters is unavailable in headless editor mode.',
    'Graph inspection is unavailable in headless editor mode because the surface is a GUI control.',
    'Graph undo is unavailable in headless editor mode.',
    'Editor selection is unavailable in headless editor mode.',
    'Flax 1.12 headless play is unavailable because the editor cannot guarantee play cleanup.',
  ]) {
    const mapped = remote('INVALID_STATE', undefined, message);
    assert.equal(mapped.code, 'HEADLESS_MODE', message);
    assert.equal(mapped.message, message);
    assert.equal(mapped.details, undefined);
  }

  // A play-mode refusal from the same edit-time gate is not headless.
  const playMode = remote('INVALID_STATE', undefined, 'material.set_parameters is an edit-time operation and is unavailable while the editor is in play mode or play was requested.');
  assert.equal(playMode.code, 'EDITOR_BUSY');

  // Only INVALID_STATE is reinterpreted: another code keeps its own mapping
  // even when its message mentions headless mode.
  assert.equal(remote('NOT_FOUND', undefined, 'Actor not found in headless editor mode.').code, 'NOT_FOUND');
  assert.equal(remote('EDITOR_BUSY', undefined, 'Busy in headless editor mode.').code, 'EDITOR_BUSY');
});

test('isHeadlessRefusal accepts message or details evidence and nothing else', () => {
  const make = (message: string, details?: unknown) => new BridgeRpcError('BRIDGE_REMOTE_ERROR', message, { code: 'INVALID_STATE', details });
  assert.equal(isHeadlessRefusal(make('x is unavailable in headless editor mode.')), true);
  assert.equal(isHeadlessRefusal(make('No surface.', { Reason: 'Headless editor has no GUI surface.' })), true);
  assert.equal(isHeadlessRefusal(make('Editor must be running to pause.', { NotReady: false })), false);
  assert.equal(isHeadlessRefusal(make('Editor must be running to pause.')), false);
});

test('mapBridgeError maps UNSUPPORTED_FLAX_VERSION and EDITOR_BUSY remote codes', () => {
  assert.equal(remote('UNSUPPORTED_FLAX_VERSION').code, 'UNSUPPORTED_FLAX_VERSION');
  assert.equal(remote('EDITOR_BUSY').code, 'EDITOR_BUSY');
});

test('mapBridgeError falls back to INTERNAL_ERROR with bridge context', () => {
  const unknownRemote = remote('SOMETHING_NEW', { hint: 1 });
  assert.equal(unknownRemote.code, 'INTERNAL_ERROR');
  assert.deepEqual(unknownRemote.details, { bridgeCode: 'BRIDGE_REMOTE_ERROR', details: { code: 'SOMETHING_NEW', details: { hint: 1 } } });

  const protocol = mapBridgeError(new BridgeRpcError('BRIDGE_PROTOCOL_ERROR', 'bad frame'));
  assert.equal(protocol.code, 'INTERNAL_ERROR');
  assert.deepEqual(protocol.details, { bridgeCode: 'BRIDGE_PROTOCOL_ERROR', details: undefined });
});
