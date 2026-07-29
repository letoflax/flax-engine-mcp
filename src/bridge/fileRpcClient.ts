import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectMeta } from '../projectContext.js';
import { EditorBridgeStatus, inspectEditorBridge } from '../tools/serverStatus.js';
import { recordIpcFailure } from '../observability.js';
import {
  BRIDGE_CACHE_DIRECTORY,
  BRIDGE_REQUESTS_DIRECTORY,
  BRIDGE_RESPONSES_DIRECTORY,
  BRIDGE_TOKEN_FILE,
  BridgeCallResult,
  BridgeConnectionMetadata,
  BridgeMethod,
  BridgeRequest,
  BridgeResponse,
  BridgeRpcError,
} from './protocol.js';

const DEFAULT_DEADLINE_MS = 15_000;
const MIN_DEADLINE_MS = 50;
const MAX_DEADLINE_MS = 60_000;
const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;
const DEFAULT_POLL_INTERVAL_MS = 20;
const MAX_PARAMS_BYTES = 64 * 1024;

export interface FileRpcClientOptions {
  deadlineMs?: number;
  maxMessageBytes?: number;
  pollIntervalMs?: number;
  /** Require a newer additive bridge capability for this call. */
  minimumBridgeVersion?: number;
}

export interface BridgeCallOptions {
  deadlineMs?: number;
  minimumBridgeVersion?: number;
}

export interface EditorBridgeCall<R = unknown> {
  data: R;
  mode: 'editor-connected';
  bridge: BridgeConnectionMetadata;
  warnings: string[];
}

interface BridgePaths {
  root: string;
  token: string;
  requests: string;
  responses: string;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BridgeRpcError('BRIDGE_PROTOCOL_ERROR', `Value must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bridgeMetadata(status: EditorBridgeStatus): BridgeConnectionMetadata {
  return {
    connected: true,
    reason: 'connected',
    pid: status.pid,
    heartbeatAgeMs: status.heartbeatAgeMs,
    editorVersion: status.editorVersion,
    bridgeVersion: status.bridgeVersion,
    protocolVersion: status.protocolVersion,
    endpoint: status.endpoint,
  };
}

function parseResponse(value: unknown): BridgeResponse {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.token !== 'string' || typeof value.ok !== 'boolean') {
    throw new BridgeRpcError('BRIDGE_RESPONSE_INVALID', 'Bridge response is missing required fields.');
  }
  if (value.ok === false && (typeof value.errorCode !== 'string' || typeof value.error !== 'string')) {
    throw new BridgeRpcError('BRIDGE_RESPONSE_INVALID', 'Failed bridge response is missing a valid error code and message.');
  }
  if (value.resultJson !== undefined && value.resultJson !== null && typeof value.resultJson !== 'string') {
    throw new BridgeRpcError('BRIDGE_RESPONSE_INVALID', 'Bridge response resultJson must be a string.');
  }
  if (value.errorDetails !== undefined && value.errorDetails !== null && typeof value.errorDetails !== 'string') {
    throw new BridgeRpcError('BRIDGE_RESPONSE_INVALID', 'Bridge response errorDetails must be a JSON string.');
  }
  return value as unknown as BridgeResponse;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}

/**
 * A deliberately narrow, single-flight file transport for the Phase-1 editor
 * bridge. It is safe to construct per MCP server instance; calls on one client
 * cannot interleave and leave a half-written command visible to the editor.
 */
export class FileRpcClient {
  private static readonly inFlightProjects = new Set<string>();
  private inFlight = false;
  private readonly deadlineMs: number;
  private readonly maxMessageBytes: number;
  private readonly pollIntervalMs: number;
  private readonly optionsMinimumBridgeVersion: number | undefined;

  constructor(
    private readonly ctx: ProjectMeta,
    options: FileRpcClientOptions = {},
  ) {
    this.deadlineMs = boundedInteger(options.deadlineMs, DEFAULT_DEADLINE_MS, MIN_DEADLINE_MS, MAX_DEADLINE_MS);
    this.maxMessageBytes = boundedInteger(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 256, 16 * 1024 * 1024);
    this.pollIntervalMs = boundedInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 1, 1_000);
    this.optionsMinimumBridgeVersion = options.minimumBridgeVersion === undefined
      ? undefined
      : boundedInteger(options.minimumBridgeVersion, 5, 5, 100);
  }

  async call<M extends BridgeMethod, P, R>(
    method: M,
    params: P,
    options: BridgeCallOptions = {},
  ): Promise<BridgeCallResult<R>> {
    const projectLockKey = process.platform === 'win32'
      ? path.resolve(this.ctx.projectPath).toLowerCase()
      : path.resolve(this.ctx.projectPath);
    if (this.inFlight || FileRpcClient.inFlightProjects.has(projectLockKey)) {
      throw new BridgeRpcError('BRIDGE_CONCURRENT_CALL', 'A bridge request is already in flight for this project.');
    }
    this.inFlight = true;
    FileRpcClient.inFlightProjects.add(projectLockKey);
    try {
      return await this.callExclusive<M, P, R>(method, params, options);
    } catch (error) {
      recordIpcFailure(error);
      throw error;
    } finally {
      this.inFlight = false;
      FileRpcClient.inFlightProjects.delete(projectLockKey);
    }
  }

  private paths(): BridgePaths {
    const root = path.join(this.ctx.projectPath, BRIDGE_CACHE_DIRECTORY);
    return {
      root,
      token: path.join(root, BRIDGE_TOKEN_FILE),
      requests: path.join(root, BRIDGE_REQUESTS_DIRECTORY),
      responses: path.join(root, BRIDGE_RESPONSES_DIRECTORY),
    };
  }

  private async callExclusive<M extends BridgeMethod, P, R>(
    method: M,
    params: P,
    options: BridgeCallOptions,
  ): Promise<BridgeCallResult<R>> {
    const deadlineMs = boundedInteger(options.deadlineMs, this.deadlineMs, MIN_DEADLINE_MS, MAX_DEADLINE_MS);
    const bridge = await inspectEditorBridge(this.ctx);
    if (!bridge.connected) {
      throw new BridgeRpcError('BRIDGE_UNAVAILABLE', `Editor bridge is unavailable: ${bridge.reason}.`, { reason: bridge.reason });
    }
    const bridgeVersion = Number(bridge.bridgeVersion);
    const phase2Method = /^(?:code|play|log|capture|runtime)\./.test(method);
    const phase3Method = /^edit\.lease_/.test(method);
    const assetRegistryMethod = /^asset\./.test(method);
    const operationMethod = /^operation\./.test(method);
    const requestedMinimum = options.minimumBridgeVersion ?? this.optionsMinimumBridgeVersion;
    const minimumBridgeVersion = Math.max(phase2Method ? 6 : 5, phase3Method ? 7 : 5, assetRegistryMethod ? 8 : 5, operationMethod ? 11 : 5, requestedMinimum ?? 5);
    if (bridge.protocolVersion !== '1' || !Number.isInteger(bridgeVersion) || bridgeVersion < minimumBridgeVersion) {
      throw new BridgeRpcError(
        'BRIDGE_UNSUPPORTED',
        'Editor bridge protocol is not compatible with this server.',
        { bridgeVersion: bridge.bridgeVersion, protocolVersion: bridge.protocolVersion, minimumBridgeVersion },
      );
    }

    const paths = this.paths();
    const token = await this.readToken(paths.token);
    const requestId = randomUUID();
    const paramsJson = JSON.stringify(params);
    if (paramsJson === undefined) {
      throw new BridgeRpcError('BRIDGE_PROTOCOL_ERROR', 'Bridge request params must be JSON serializable.');
    }
    if (Buffer.byteLength(paramsJson, 'utf8') > MAX_PARAMS_BYTES) {
      throw new BridgeRpcError('BRIDGE_MESSAGE_TOO_LARGE', `Bridge request params exceed ${MAX_PARAMS_BYTES} bytes.`);
    }
    const request: BridgeRequest<M> = {
      id: requestId,
      token,
      method,
      paramsJson,
      deadlineUnixMs: Date.now() + deadlineMs,
    };
    const requestPath = path.join(paths.requests, `${requestId}.json`);
    const responsePath = path.join(paths.responses, `${requestId}.json`);

    try {
      await fs.mkdir(paths.requests, { recursive: true });
      await fs.mkdir(paths.responses, { recursive: true });
      await this.atomicJsonWrite(requestPath, request);
      const response = await this.waitForResponse(responsePath, requestId, token, deadlineMs);
      if (!response.ok) {
        let details: unknown;
        if (response.errorDetails) {
          try { details = JSON.parse(response.errorDetails); } catch { details = response.errorDetails; }
        }
        throw new BridgeRpcError('BRIDGE_REMOTE_ERROR', response.error!, { code: response.errorCode, details });
      }
      let result: R | undefined;
      if (response.resultJson !== undefined && response.resultJson !== null) {
        try {
          result = JSON.parse(response.resultJson) as R;
        } catch {
          throw new BridgeRpcError('BRIDGE_RESPONSE_INVALID', 'Bridge response resultJson is not valid JSON.');
        }
      }
      return {
        result: result as R,
        warnings: [],
        bridge: bridgeMetadata(bridge),
      };
    } finally {
      await Promise.allSettled([fs.unlink(requestPath), fs.unlink(responsePath)]);
    }
  }

  private async readToken(tokenPath: string): Promise<string> {
    let token: string;
    try {
      token = (await this.readBounded(tokenPath)).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BridgeRpcError('BRIDGE_AUTH_FAILED', 'Editor bridge token file is missing.');
      }
      throw error;
    }
    if (token.length < 16 || token.length > 4_096 || /[\r\n\0]/.test(token)) {
      throw new BridgeRpcError('BRIDGE_AUTH_FAILED', 'Editor bridge token is invalid.');
    }
    return token;
  }

  private async atomicJsonWrite(filePath: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes > this.maxMessageBytes) {
      throw new BridgeRpcError('BRIDGE_MESSAGE_TOO_LARGE', `Bridge request exceeds ${this.maxMessageBytes} bytes.`);
    }
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async waitForResponse(
    responsePath: string,
    requestId: string,
    expectedToken: string,
    deadlineMs: number,
  ): Promise<BridgeResponse> {
    const end = Date.now() + deadlineMs;
    while (Date.now() <= end) {
      try {
        const raw = await this.readBounded(responsePath);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new BridgeRpcError('BRIDGE_RESPONSE_INVALID', 'Bridge response is not valid JSON.');
        }
        const response = parseResponse(parsed);
        if (response.id !== requestId) {
          throw new BridgeRpcError('BRIDGE_RESPONSE_INVALID', 'Bridge response id does not match the request.');
        }
        const actualToken = Buffer.from(response.token, 'utf8');
        const trustedToken = Buffer.from(expectedToken, 'utf8');
        if (actualToken.length !== trustedToken.length || !timingSafeEqual(actualToken, trustedToken)) {
          throw new BridgeRpcError('BRIDGE_AUTH_FAILED', 'Bridge response token does not match the active editor session.');
        }
        return response;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await delay(this.pollIntervalMs);
    }
    throw new BridgeRpcError('BRIDGE_TIMEOUT', `Editor bridge did not respond within ${deadlineMs}ms.`);
  }

  private async readBounded(filePath: string): Promise<string> {
    const handle = await fs.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size > this.maxMessageBytes) {
        throw new BridgeRpcError('BRIDGE_MESSAGE_TOO_LARGE', `Bridge message exceeds ${this.maxMessageBytes} bytes.`);
      }
      return await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
  }
}

/**
 * Stable convenience entry point for future scene/actor tool handlers.
 * It intentionally exposes no file paths or token material to the tool layer.
 */
export async function callEditorBridge<M extends BridgeMethod, P, R>(
  ctx: ProjectMeta,
  method: M,
  params: P,
  options: FileRpcClientOptions = {},
): Promise<EditorBridgeCall<R>> {
  const client = new FileRpcClient(ctx, options);
  const response = await client.call<M, P, R>(method, params, { deadlineMs: options.deadlineMs, minimumBridgeVersion: options.minimumBridgeVersion });
  return {
    data: response.result,
    mode: 'editor-connected',
    bridge: response.bridge,
    warnings: response.warnings,
  };
}
