import fs from 'node:fs/promises';
import path from 'node:path';
import type { ToolResponse } from './errors.js';
import { ProjectMeta } from './projectContext.js';
import { isSubscribableFlaxResource } from './resources.js';

const MaxSubscriptions = 128;
const DebounceMs = 350;
const HeartbeatPollMs = 2_500;

export type ResourceNotifier = (method: 'notifications/resources/updated' | 'notifications/resources/list_changed', params: Record<string, never> | { uri: string }) => Promise<void>;

/**
 * Stdio has one client connection, so subscriptions are process-local. The manager
 * intentionally observes only successful MCP-dispatched mutations plus the bridge
 * heartbeat. It never claims to receive Flax editor events that the bridge lacks.
 */
export class ResourceSubscriptionManager {
  private readonly subscriptions = new Set<string>();
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatFingerprint = '';

  constructor(private readonly ctx: ProjectMeta, private readonly notify: ResourceNotifier) {}

  subscribe(uri: string): void {
    if (!isSubscribableFlaxResource(uri)) throw new Error('Resource is not available for subscriptions.');
    if (!this.subscriptions.has(uri) && this.subscriptions.size >= MaxSubscriptions) throw new Error(`At most ${MaxSubscriptions} resource subscriptions are allowed.`);
    this.subscriptions.add(uri); // idempotent by protocol design
    this.updatePolling();
  }

  unsubscribe(uri: string): void {
    this.subscriptions.delete(uri); // idempotent by protocol design
    const timer = this.scheduled.get(uri);
    if (timer) { clearTimeout(timer); this.scheduled.delete(uri); }
    this.updatePolling();
  }

  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    this.subscriptions.clear();
  }

  private updatePolling(): void {
    const needsHeartbeat = this.subscriptions.has('flax://editor/status');
    if (needsHeartbeat && !this.heartbeatTimer) {
      void this.pollHeartbeat();
      this.heartbeatTimer = setInterval(() => { void this.pollHeartbeat(); }, HeartbeatPollMs);
    } else if (!needsHeartbeat && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; this.heartbeatFingerprint = '';
    }
  }

  private async pollHeartbeat(): Promise<void> {
    if (!this.subscriptions.has('flax://editor/status')) return;
    try {
      const file = path.join(this.ctx.projectPath, 'Cache', 'MCP', 'bridge.json');
      const stat = await fs.stat(file);
      // A stat fingerprint is bounded and avoids an RPC or exposing the heartbeat path/content.
      const fingerprint = `${stat.mtimeMs}:${stat.size}`;
      if (this.heartbeatFingerprint && this.heartbeatFingerprint !== fingerprint) this.schedule('flax://editor/status');
      this.heartbeatFingerprint = fingerprint;
    } catch {
      if (this.heartbeatFingerprint) { this.heartbeatFingerprint = ''; this.schedule('flax://editor/status'); }
    }
  }

  private schedule(uri: string): void {
    if (!this.subscriptions.has(uri) || this.scheduled.has(uri)) return;
    const timer = setTimeout(() => {
      this.scheduled.delete(uri);
      if (!this.subscriptions.has(uri)) return;
      void this.notify('notifications/resources/updated', { uri }).catch(() => undefined);
    }, DebounceMs);
    this.scheduled.set(uri, timer);
  }

  notifyResourceListChanged(): void {
    void this.notify('notifications/resources/list_changed', {}).catch(() => undefined);
  }

  /** Called once after dispatch, never before the tool response is known to be successful. */
  afterTool(name: string, response: ToolResponse): void {
    if (response.isError) return;
    const sceneMutation = new Set([
      'scene_save', 'project_save_all', 'actor_create', 'actor_update', 'actor_delete', 'actor_duplicate', 'actor_reparent',
      'script_attach', 'script_detach', 'script_instance_update', 'edit_undo', 'edit_redo',
    ]).has(name);
    const sourceMutation = new Set(['write_script', 'apply_script_patch', 'generate_script', 'code_compile', 'code_generate_project']).has(name);
    const runtimeMutation = new Set(['play_start_scenes', 'play_start_game', 'play_stop', 'play_pause', 'play_resume', 'play_step_frame', 'play_run_for', 'code_compile', 'code_generate_project']).has(name);
    const generalMutation = sceneMutation || sourceMutation || runtimeMutation || /^(?:reimport_asset|install_editor_bridge)$/.test(name);
    if (sceneMutation) for (const uri of this.subscriptions) if (/^flax:\/\/scene\/[0-9a-f]{32}\/tree$/i.test(uri)) this.schedule(uri);
    if (sourceMutation) this.schedule('flax://code/diagnostics/latest');
    if (runtimeMutation) this.schedule('flax://logs/recent');
    if (generalMutation) this.schedule('flax://editor/status');
    if (name === 'viewport_capture') this.notifyResourceListChanged();
  }
}
