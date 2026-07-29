import assert from 'node:assert/strict';
import test from 'node:test';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { getFlaxPrompt, listFlaxPrompts } from './prompts.js';

test('prompt registry lists the five guided workflows with MCP argument metadata', () => {
  const listed = listFlaxPrompts();
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

test('prompt get validates Record<string,string> booleans and integers before rendering guidance', () => {
  const result = getFlaxPrompt('debug_runtime_exception', {
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

test('prompt get rejects missing, unknown, and malformed MCP string arguments', () => {
  const invalid = (callback: () => unknown, expression: RegExp) => {
    assert.throws(callback, error => error instanceof McpError && error.code === ErrorCode.InvalidParams && expression.test(error.message));
  };
  invalid(() => getFlaxPrompt('create_gameplay_feature', {}), /Missing required argument/);
  invalid(() => getFlaxPrompt('fix_compile_errors', { unexpected: 'x' }), /Unknown argument/);
  invalid(() => getFlaxPrompt('debug_runtime_exception', { symptom: 'x', apply_fix: 'TRUE' }), /exactly "true" or "false"/);
  invalid(() => getFlaxPrompt('debug_runtime_exception', { symptom: 'x', apply_fix: true }), /must be a string/);
  invalid(() => getFlaxPrompt('debug_runtime_exception', { symptom: 'x', run_seconds: '001' }), /base-10 integer/);
  invalid(() => getFlaxPrompt('debug_runtime_exception', { symptom: 'x', run_seconds: '121' }), /from 1 to 120/);
  invalid(() => getFlaxPrompt('unknown_prompt', {}), /Unknown prompt/);
});

test('prompt lookup is pure guidance and returns only MCP prompt messages', () => {
  const result = getFlaxPrompt('prepare_release_build', { target: 'Windows', save_at_end: 'true' });
  assert.deepEqual(Object.keys(result).sort(), ['description', 'messages']);
  assert.equal(result.messages[0]?.role, 'user');
  assert.equal(result.messages[0]?.content.type, 'text');
  assert.match((result.messages[0]?.content as { text: string }).text, /does not grant permission/);
});
