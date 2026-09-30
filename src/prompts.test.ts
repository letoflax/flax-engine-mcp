import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createProjectContext } from './projectContext.js';
import { getFlaxPrompt, listFlaxPrompts } from './prompts.js';
import { buildToolRegistry } from './tools/index.js';

test('prompt registry lists the five guided workflows with MCP argument metadata', async () => {
  const listed = await listFlaxPrompts();
  assert.deepEqual(listed.prompts.map(prompt => prompt.name), [
    'create_gameplay_feature',
    'fix_compile_errors',
    'create_scene_from_description',
    'debug_runtime_exception',
    'prepare_release_build',
  ]);
  const gameplay = listed.prompts[0]!;
  assert.equal(gameplay.title, 'Create gameplay feature');
  assert.deepEqual(gameplay.arguments?.map(argument => [argument.name, argument.required]), [
    ['feature', true], ['target_scene', false], ['max_compile_attempts', false], ['save_at_end', false],
  ]);
});

test('prompt get validates Record<string,string> booleans and integers before rendering guidance', async () => {
  const result = await getFlaxPrompt('debug_runtime_exception', {
    symptom: 'NullReferenceException in Player.Update', run_seconds: '10', apply_fix: 'false',
  });
  assert.equal(result.messages.length, 1);
  const text = result.messages[0]?.content.type === 'text' ? result.messages[0].content.text : '';
  assert.match(text, /NullReferenceException/);
  assert.match(text, /Maximum reproduction duration: 10 seconds/);
  assert.match(text, /resources\/list/);
  assert.match(text, /dry_run:true/);
  assert.match(text, /transactions and atomic batches are unavailable/);
  assert.equal(result.messages.some(message => message.content.type === 'resource_link'), false);
});

test('prompt get rejects missing, unknown, and malformed MCP string arguments', async () => {
  const invalid = async (callback: () => Promise<unknown>, expression: RegExp) => {
    await assert.rejects(callback, error => error instanceof McpError && error.code === ErrorCode.InvalidParams && expression.test(error.message));
  };
  await invalid(() => getFlaxPrompt('create_gameplay_feature', {}), /Missing required argument/);
  await invalid(() => getFlaxPrompt('fix_compile_errors', { unexpected: 'x' }), /Unknown argument/);
  await invalid(() => getFlaxPrompt('debug_runtime_exception', { symptom: 'x', apply_fix: 'TRUE' }), /exactly "true" or "false"/);
  await invalid(() => getFlaxPrompt('debug_runtime_exception', { symptom: 'x', apply_fix: true }), /must be a string/);
  await invalid(() => getFlaxPrompt('debug_runtime_exception', { symptom: 'x', run_seconds: '001' }), /base-10 integer/);
  await invalid(() => getFlaxPrompt('debug_runtime_exception', { symptom: 'x', run_seconds: '121' }), /from 1 to 120/);
  await invalid(() => getFlaxPrompt('unknown_prompt', {}), /Unknown prompt/);
});

test('prompt lookup is pure guidance and returns only MCP prompt messages', async () => {
  const result = await getFlaxPrompt('prepare_release_build', { target: 'Windows', save_at_end: 'true' });
  assert.deepEqual(Object.keys(result).sort(), ['description', 'messages']);
  assert.equal(result.messages[0]?.role, 'user');
  assert.equal(result.messages[0]?.content.type, 'text');
  assert.match((result.messages[0]?.content as { text: string }).text, /does not grant permission/);
});

async function makeProject(): Promise<{ root: string; promptsDir: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-prompts-'));
  const promptsDir = path.join(root, 'mcp-prompts');
  await fs.mkdir(promptsDir, { recursive: true });
  return { root, promptsDir, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test('project-local prompt file is listed and fetched with heading description', async () => {
  const f = await makeProject();
  try {
    await fs.writeFile(path.join(f.promptsDir, 'team_guide.md'), '# Team Guide\n\nFollow these steps.\n');
    const listed = await listFlaxPrompts(f.root);
    const names = listed.prompts.map(prompt => prompt.name);
    assert.ok(names.includes('team_guide'));
    const entry = listed.prompts.find(prompt => prompt.name === 'team_guide')!;
    assert.equal(entry.description, 'Team Guide');
    assert.deepEqual(entry.arguments, []);
    const fetched = await getFlaxPrompt('team_guide', {}, f.root);
    assert.equal(fetched.description, 'Team Guide');
    assert.equal(fetched.messages.length, 1);
    assert.equal(fetched.messages[0]?.role, 'user');
    const text = fetched.messages[0]?.content.type === 'text' ? fetched.messages[0].content.text : '';
    assert.match(text, /Follow these steps/);
    const noHeading = await (async () => {
      await fs.writeFile(path.join(f.promptsDir, 'plain.md'), 'Just body text.\n');
      const relisted = await listFlaxPrompts(f.root);
      return relisted.prompts.find(prompt => prompt.name === 'plain')!;
    })();
    assert.equal(noHeading.description, 'plain');
  } finally { await f.cleanup(); }
});

test('project-local bad-name and oversized files are skipped with a skipped count', async () => {
  const f = await makeProject();
  try {
    await fs.writeFile(path.join(f.promptsDir, 'good_one.md'), '# Good\n\nok\n');
    await fs.writeFile(path.join(f.promptsDir, 'bad!.md'), '# Bad\n\nno\n');
    await fs.writeFile(path.join(f.promptsDir, 'big_file.md'), 'x'.repeat(33 * 1024));
    const listed = await listFlaxPrompts(f.root);
    const names = listed.prompts.map(prompt => prompt.name);
    assert.ok(names.includes('good_one'));
    assert.equal(names.includes('bad!'), false);
    assert.equal(names.includes('big_file'), false);
    const skipped = (listed as { _meta?: { projectPromptsSkipped?: number } })._meta?.projectPromptsSkipped ?? 0;
    assert.ok(skipped >= 2);
    await assert.rejects(() => getFlaxPrompt('big_file', {}, f.root), error => error instanceof McpError && /Unknown prompt/.test(error.message));
  } finally { await f.cleanup(); }
});

test('project-local symlink escape is skipped', async t => {
  const f = await makeProject();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-prompts-outside-'));
  try {
    const outsideFile = path.join(outside, 'secret.md');
    await fs.writeFile(outsideFile, '# Secret\n\noutside\n');
    const link = path.join(f.promptsDir, 'evil.md');
    try {
      await fs.symlink(outsideFile, link);
    } catch {
      t.skip('Creating symlinks is not permitted on this host.');
      return;
    }
    const listed = await listFlaxPrompts(f.root);
    assert.equal(listed.prompts.some(prompt => prompt.name === 'evil'), false);
    const skipped = (listed as { _meta?: { projectPromptsSkipped?: number } })._meta?.projectPromptsSkipped ?? 0;
    assert.ok(skipped >= 1);
    await assert.rejects(() => getFlaxPrompt('evil', {}, f.root), error => error instanceof McpError && /Unknown prompt/.test(error.message));
  } finally {
    await f.cleanup();
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('project-local built-in collision is skipped and built-in wins', async () => {
  const f = await makeProject();
  try {
    await fs.writeFile(path.join(f.promptsDir, 'fix_compile_errors.md'), '# Impostor\n\nnot the built-in\n');
    const listed = await listFlaxPrompts(f.root);
    const matches = listed.prompts.filter(prompt => prompt.name === 'fix_compile_errors');
    assert.equal(matches.length, 1);
    assert.match(matches[0]!.description ?? '', /diagnostic-driven/);
    const skipped = (listed as { _meta?: { projectPromptsSkipped?: number } })._meta?.projectPromptsSkipped ?? 0;
    assert.ok(skipped >= 1);
    const fetched = await getFlaxPrompt('fix_compile_errors', { max_attempts: '2' }, f.root);
    const text = fetched.messages[0]?.content.type === 'text' ? fetched.messages[0].content.text : '';
    assert.match(text, /at most 2 edit/);
  } finally { await f.cleanup(); }
});

test('project-local missing directory returns only built-ins without an error', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-prompts-missing-'));
  try {
    const listed = await listFlaxPrompts(root);
    assert.deepEqual(listed.prompts.map(prompt => prompt.name), [
      'create_gameplay_feature',
      'fix_compile_errors',
      'create_scene_from_description',
      'debug_runtime_exception',
      'prepare_release_build',
    ]);
    const fetched = await getFlaxPrompt('fix_compile_errors', {}, root);
    assert.equal(fetched.messages.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('project-local prompts/get rejects unknown names and any arguments', async () => {
  const f = await makeProject();
  try {
    await fs.writeFile(path.join(f.promptsDir, 'zero_args.md'), '# Zero\n\nbody\n');
    await assert.rejects(() => getFlaxPrompt('missing_prompt', {}, f.root), error => error instanceof McpError && error.code === ErrorCode.InvalidParams && /Unknown prompt/.test(error.message));
    await assert.rejects(() => getFlaxPrompt('zero_args', { extra: 'x' }, f.root), error => error instanceof McpError && error.code === ErrorCode.InvalidParams && /Unknown argument/.test(error.message));
    await assert.rejects(() => getFlaxPrompt('zero_args', 'x' as unknown as Record<string, string>, f.root), error => error instanceof McpError && /must be an object/.test(error.message));
    const ok = await getFlaxPrompt('zero_args', undefined, f.root);
    assert.equal(ok.messages.length, 1);
  } finally { await f.cleanup(); }
});

// ── Guidance stays in step with the tool registry ───────────────────────────

const MINIMAL_ARGUMENTS: Record<string, Record<string, string>> = {
  create_gameplay_feature: { feature: 'double jump' },
  fix_compile_errors: {},
  create_scene_from_description: { description: 'a small arena' },
  debug_runtime_exception: { symptom: 'NullReferenceException' },
  prepare_release_build: {},
};

async function renderedPrompts(): Promise<Map<string, string>> {
  const rendered = new Map<string, string>();
  for (const [name, args] of Object.entries(MINIMAL_ARGUMENTS)) {
    const result = await getFlaxPrompt(name, args);
    const content = result.messages[0]?.content;
    rendered.set(name, content?.type === 'text' ? content.text : '');
  }
  return rendered;
}

async function registeredToolNames(): Promise<Set<string>> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-prompts-registry-'));
  try {
    await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
    return new Set(buildToolRegistry(await createProjectContext(root)).map(tool => tool.name));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('prompt names, titles, and arguments are unchanged', async () => {
  const listed = await listFlaxPrompts();
  assert.deepEqual(listed.prompts.map(prompt => [prompt.name, prompt.title, (prompt.arguments ?? []).map(argument => [argument.name, argument.required])]), [
    ['create_gameplay_feature', 'Create gameplay feature', [['feature', true], ['target_scene', false], ['max_compile_attempts', false], ['save_at_end', false]]],
    ['fix_compile_errors', 'Fix compile errors', [['max_attempts', false], ['save_at_end', false]]],
    ['create_scene_from_description', 'Create scene from description', [['description', true], ['scene_name', false], ['dry_run', false], ['save_at_end', false]]],
    ['debug_runtime_exception', 'Debug runtime exception', [['symptom', true], ['run_seconds', false], ['apply_fix', false]]],
    ['prepare_release_build', 'Prepare release build', [['target', false], ['max_compile_attempts', false], ['save_at_end', false]]],
  ]);
});

test('every tool a prompt names exists in the tool registry', async () => {
  const tools = await registeredToolNames();
  // snake_case words in the guidance that are arguments or parameters, not tools.
  const notTools = new Set([
    'allow_dirty', 'apply_fix', 'dry_run', 'expected_hash', 'include_values', 'invoke_script_method', 'save_at_end', 'set_script_value',
  ]);
  const seenNotTools = new Set<string>();
  for (const [name, text] of await renderedPrompts()) {
    const words = new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []);
    for (const word of words) {
      if (notTools.has(word)) seenNotTools.add(word);
      else assert.ok(tools.has(word), `${name} names "${word}", which is not a registered tool`);
    }
  }
  // A stale allow-list entry would hide a typo, so each entry must still be used.
  assert.deepEqual([...notTools].filter(word => !seenNotTools.has(word)).sort(), []);
  // Wildcard mentions stand for real families.
  assert.ok([...tools].some(tool => tool.startsWith('settings_')));
});

test('each workflow points at the tools that exist for it today', async () => {
  const rendered = await renderedPrompts();
  const expectations: Record<string, string[]> = {
    create_gameplay_feature: [
      'actor_get_properties', 'actor_set_property', 'script_instance_set_value', 'ui_control_create', 'ui_control_set_property',
      'settings_set_input_action', 'settings_set_input_axis', 'material_set_parameters', 'particle_set_parameter',
      'test_run_scenario', 'runtime_set_script_value', 'runtime_invoke_script_method',
    ],
    fix_compile_errors: ['code_get_diagnostics', 'code_compile', 'apply_script_patch', 'get_editor_bridge_installation'],
    create_scene_from_description: [
      'scene_create', 'scene_open', 'scene_close', 'asset_create', 'content_create_folder', 'actor_get_properties', 'actor_set_property',
      'ui_control_create', 'material_assign_to_actor', 'material_create_instance', 'prefab_instantiate', 'prefab_get_overrides', 'particle_set_parameter',
    ],
    debug_runtime_exception: [
      'log_get_runtime_errors', 'actor_get_properties', 'runtime_inspect_actor', 'runtime_set_script_value', 'runtime_invoke_script_method',
      'test_run_scenario', 'play_step_frame',
    ],
    prepare_release_build: [
      'build_list_targets', 'build_validate', 'build_cook', 'build_get_status', 'build_get_result', 'build_cancel', 'operation_get_status',
      'prefab_get_overrides', 'prefab_apply_overrides', 'settings_set_first_scene', 'test_run_scenario',
    ],
  };
  for (const [name, tools] of Object.entries(expectations)) {
    const text = rendered.get(name)!;
    for (const tool of tools) assert.match(text, new RegExp(`\\b${tool}\\b`), `${name} should mention ${tool}`);
  }
});

test('the shared guidance keeps its safety rules and drops the claims that went stale', async () => {
  for (const [name, text] of await renderedPrompts()) {
    // Rules that still hold.
    assert.match(text, /does not grant permission/, name);
    assert.match(text, /dry_run:true/, name);
    assert.match(text, /explicit confirmation/, name);
    assert.match(text, /coordination locks, not transactions/, name);
    assert.match(text, /transactions and atomic batches are unavailable/, name);
    assert.match(text, /input_key_press and input_mouse_click only validate and then report UNSUPPORTED_FLAX_VERSION/, name);
    assert.match(text, /Durable writes have no undo: settings_\* saves, scene_create, asset_create/, name);
    assert.match(text, /always stop play/, name);
    // What exists now is named rather than declared unsupported.
    assert.match(text, /_meta\.progressToken/, name);
    assert.match(text, /buildCook\.available/, name);
    assert.match(text, /runtime_invoke_script_method/, name);
    // Stale claims.
    assert.doesNotMatch(text, /may be unsupported/, name);
    assert.doesNotMatch(text, /unless a supported tool explicitly advertises/, name);
    assert.doesNotMatch(text, /property-editing, prefab, and build\/cook operations/, name);
  }
});

test('prepare_release_build no longer describes build and cook as unsupported', async () => {
  const listed = await listFlaxPrompts();
  const release = listed.prompts.find(prompt => prompt.name === 'prepare_release_build')!;
  assert.doesNotMatch(release.description ?? '', /unsupported/i);
  assert.match(release.description ?? '', /build\/cook/);
  const text = (await renderedPrompts()).get('prepare_release_build')!;
  assert.match(text, /BUILD_NOT_COMPLETE/);
  assert.match(text, /only after explicit confirmation/);
  assert.match(text, /empty project-relative Builds\/ directory/);
});
