import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectContext, ProjectMeta } from '../projectContext.js';

/**
 * Deterministic filesystem fixture for integration-shaped tests. This is not a
 * Flax Editor process: callers explicitly drive the file-RPC peer through the
 * harness below. Real Editor tests remain opt-in (see docs/TESTING.md).
 */
export interface EditorIntegrationFixture {
  root: string;
  ctx: ProjectMeta;
  cache: string;
  requests: string;
  responses: string;
  source: string;
  content: string;
  cleanup: () => Promise<void>;
}

export const TEST_BRIDGE_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

export async function createEditorIntegrationFixture(options: {
  bridgeVersion?: number;
  token?: string;
} = {}): Promise<EditorIntegrationFixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-editor-integration-'));
  const cache = path.join(root, 'Cache', 'MCP');
  const requests = path.join(cache, 'requests');
  const responses = path.join(cache, 'responses');
  const source = path.join(root, 'Source', 'Game');
  const content = path.join(root, 'Content');
  await Promise.all([
    fs.mkdir(requests, { recursive: true }),
    fs.mkdir(responses, { recursive: true }),
    fs.mkdir(source, { recursive: true }),
    fs.mkdir(path.join(content, 'Scenes'), { recursive: true }),
    fs.mkdir(path.join(content, 'Prefabs'), { recursive: true }),
    fs.mkdir(path.join(content, 'Materials'), { recursive: true }),
    fs.mkdir(path.join(content, 'Textures'), { recursive: true }),
    fs.mkdir(path.join(content, 'Models'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(root, 'IntegrationFixture.flaxproj'), JSON.stringify({
    Name: 'IntegrationFixture', ProjectId: 'integration-fixture-guid', MinEngineVersion: '1.12',
  }, null, 2));
  // These compact JSON fixtures are intentionally generic asset placeholders;
  // the helper proves project layout and transport setup without claiming that
  // a live Editor imported their contents.
  await Promise.all([
    fs.writeFile(path.join(content, 'Scenes', 'Main.scene'), JSON.stringify({
      ID: '1'.repeat(32), Actors: [
        { ID: 'a'.repeat(32), Name: 'Root', TypeName: 'FlaxEngine.EmptyActor', Children: ['b'.repeat(32), 'c'.repeat(32)] },
        { ID: 'b'.repeat(32), ParentID: 'a'.repeat(32), Name: 'Camera', TypeName: 'FlaxEngine.Camera' },
        { ID: 'c'.repeat(32), ParentID: 'a'.repeat(32), Name: 'Lighting', TypeName: 'FlaxEngine.DirectionalLight', Children: ['d'.repeat(32)] },
        { ID: 'd'.repeat(32), ParentID: 'c'.repeat(32), Name: 'MeshCollider', TypeName: 'FlaxEngine.StaticModel', Collider: 'FlaxEngine.BoxCollider' },
      ],
    })),
    fs.writeFile(path.join(content, 'Scenes', 'Secondary.scene'), JSON.stringify({ ID: '2'.repeat(32), Actors: [] })),
    fs.writeFile(path.join(content, 'Prefabs', 'TestActor.prefab'), JSON.stringify({ ID: '3'.repeat(32), Actors: [] })),
    fs.writeFile(path.join(content, 'Materials', 'Test.material'), JSON.stringify({ ID: '4'.repeat(32), TypeName: 'FlaxEngine.Material' })),
    fs.writeFile(path.join(content, 'Textures', 'Test.png'), 'fixture texture placeholder\n'),
    fs.writeFile(path.join(content, 'Models', 'Test.fbx'), 'fixture model placeholder\n'),
    fs.writeFile(path.join(source, 'FixtureScript.cs'), 'public class FixtureScript : FlaxEngine.Script { }\n'),
    fs.writeFile(path.join(source, 'NetworkFixtureScript.cs'), 'public class NetworkFixtureScript : FlaxEngine.Networking.NetworkScript { }\n'),
    fs.writeFile(path.join(source, 'IntentionalCompileFailure.cs'), 'public class IntentionalCompileFailure { BROKEN }\n'),
  ]);
  await writeBridgeHeartbeat(root, {
    bridgeVersion: options.bridgeVersion ?? 8,
    token: options.token ?? TEST_BRIDGE_TOKEN,
  });
  return {
    root, ctx: await createProjectContext(root), cache, requests, responses, source, content,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

export async function writeBridgeHeartbeat(root: string, options: {
  bridgeVersion?: number;
  token?: string;
  timestamp?: number;
  remove?: boolean;
} = {}): Promise<void> {
  const cache = path.join(root, 'Cache', 'MCP');
  if (options.remove) {
    await Promise.allSettled([fs.unlink(path.join(cache, 'bridge.json')), fs.unlink(path.join(cache, 'token'))]);
    return;
  }
  await fs.writeFile(path.join(cache, 'bridge.json'), JSON.stringify({
    Pid: process.pid, Project: root, Timestamp: options.timestamp ?? Date.now(),
    BridgeVersion: options.bridgeVersion ?? 8, ProtocolVersion: 1, EditorVersion: '1.12',
  }));
  await fs.writeFile(path.join(cache, 'token'), options.token ?? TEST_BRIDGE_TOKEN);
}

export interface HarnessRequest {
  name: string;
  body: Record<string, unknown>;
}

export async function waitForHarnessRequest(directory: string, timeoutMs = 1_000): Promise<HarnessRequest> {
  const until = Date.now() + timeoutMs;
  while (Date.now() <= until) {
    const name = (await fs.readdir(directory)).find(entry => entry.endsWith('.json'));
    if (name) return { name, body: JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as Record<string, unknown> };
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for a bridge request after ${timeoutMs}ms.`);
}

export async function respondToHarness(
  fixture: EditorIntegrationFixture,
  request: HarnessRequest,
  response: Record<string, unknown>,
): Promise<void> {
  const target = path.join(fixture.responses, request.name);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ token: TEST_BRIDGE_TOKEN, ...response }));
  await fs.rename(temporary, target);
}

export async function canCreateDirectorySymlink(root: string): Promise<boolean> {
  const target = path.join(root, 'symlink-target');
  const link = path.join(root, 'symlink-link');
  await fs.mkdir(target);
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(link, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
}
