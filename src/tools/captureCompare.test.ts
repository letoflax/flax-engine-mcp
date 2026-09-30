import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectContext, ProjectMeta } from '../projectContext.js';
import { readFlaxResource } from '../resources.js';
import { isToolAllowed } from '../permissions.js';
import { buildToolRegistry } from './index.js';
import { dispatchToolCall } from '../index.js';
import { CaptureCompareSchema, decodePng, encodePngRgba, handleCaptureCompare } from './captureCompare.js';

// Self-contained fixtures: deterministic gradient PNGs generated in-test.
// (A previous revision copied real captures from another project; those files
// expire via the 24h capture TTL, so tests must not depend on them.)
const WIDE_W = 64;
const WIDE_H = 48;
const TALL_W = 40;
const TALL_H = 30;

function gradientRgba(width: number, height: number): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      rgba[i] = x % 256;
      rgba[i + 1] = y % 256;
      rgba[i + 2] = (x + y) % 256;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

async function putPng(captures: string, id: string, width: number, height: number, rgba?: Buffer): Promise<void> {
  await fs.writeFile(path.join(captures, `${id}.png`), encodePngRgba(width, height, rgba ?? gradientRgba(width, height)));
}

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const ID_C = 'c'.repeat(32);
const ID_D = 'd'.repeat(32);

async function fixture(): Promise<{ root: string; ctx: ProjectMeta; captures: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flax-mcp-capture-compare-'));
  await fs.writeFile(path.join(root, 'Fixture.flaxproj'), JSON.stringify({ Name: 'Fixture' }));
  const captures = path.join(root, 'Cache', 'MCP', 'captures');
  await fs.mkdir(captures, { recursive: true });
  return { root, ctx: await createProjectContext(root), captures, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function envelopeOf(result: Awaited<ReturnType<typeof handleCaptureCompare>>): Record<string, any> {
  return result.structuredContent as Record<string, any>;
}

test('identical real captures match with zero diff', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    await putPng(f.captures, ID_B, WIDE_W, WIDE_H);
    const result = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_B }), f.ctx);
    assert.equal(result.isError, undefined);
    const envelope = envelopeOf(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.match, true);
    assert.equal(envelope.data.width, WIDE_W);
    assert.equal(envelope.data.height, WIDE_H);
    assert.equal(envelope.data.diff_pixels, 0);
    assert.equal(envelope.data.diff_fraction, 0);
    assert.equal(envelope.data.max_channel_diff, 0);
    assert.equal('diff_uri' in envelope.data, false);
  } finally { await f.cleanup(); }
});

test('modified real capture reports sane diff counts and honours the threshold', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    const rgba = gradientRgba(WIDE_W, WIDE_H);
    const changed = 7;
    for (let i = 0; i < changed; i += 1) {
      rgba[i * 4] = 255 - rgba[i * 4];
      rgba[i * 4 + 1] = 255;
      rgba[i * 4 + 2] = 0;
    }
    await fs.writeFile(path.join(f.captures, `${ID_C}.png`), encodePngRgba(WIDE_W, WIDE_H, rgba));
    const strict = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_C, threshold: 0 }), f.ctx);
    const strictData = envelopeOf(strict).data;
    assert.equal(strictData.match, false);
    assert.equal(strictData.width, WIDE_W);
    assert.equal(strictData.height, WIDE_H);
    assert.equal(strictData.diff_pixels, changed);
    assert.equal(strictData.diff_fraction, changed / (WIDE_W * WIDE_H));
    assert.ok(strictData.max_channel_diff > 0);
    const def = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_C }), f.ctx);
    assert.equal(envelopeOf(def).data.match, true); // 7 px is far below the default 1% threshold
    const lenient = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_C, threshold: 1 }), f.ctx);
    assert.equal(envelopeOf(lenient).data.match, true);
  } finally { await f.cleanup(); }
});

test('different-size real captures report dimension_mismatch', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    await putPng(f.captures, ID_B, TALL_W, TALL_H);
    const result = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_B }), f.ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(envelopeOf(result).data, {
      match: false,
      reason: 'dimension_mismatch',
      base: { width: WIDE_W, height: WIDE_H },
      other: { width: TALL_W, height: TALL_H },
    });
  } finally { await f.cleanup(); }
});

test('crafted minimal PNG of a different size reports dimension_mismatch', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    await fs.writeFile(path.join(f.captures, `${ID_D}.png`), encodePngRgba(4, 3, Buffer.alloc(4 * 3 * 4, 128)));
    const result = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_D }), f.ctx);
    assert.deepEqual(envelopeOf(result).data, {
      match: false,
      reason: 'dimension_mismatch',
      base: { width: WIDE_W, height: WIDE_H },
      other: { width: 4, height: 3 },
    });
  } finally { await f.cleanup(); }
});

test('URI and bare-id references are both accepted', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    await putPng(f.captures, ID_B, WIDE_W, WIDE_H);
    const mixed = await handleCaptureCompare(
      CaptureCompareSchema.parse({ base: `flax://capture/${ID_A}`, other: ID_B }), f.ctx);
    assert.equal(envelopeOf(mixed).data.match, true);
    const uris = await handleCaptureCompare(
      CaptureCompareSchema.parse({ base: `flax://capture/${ID_A}`, other: `flax://capture/${ID_B}` }), f.ctx);
    assert.equal(envelopeOf(uris).data.match, true);
  } finally { await f.cleanup(); }
});

test('truncated and non-PNG captures fail with clean errors', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    const full = await fs.readFile(path.join(f.captures, `${ID_A}.png`));
    await fs.writeFile(path.join(f.captures, `${ID_B}.png`), full.subarray(0, 200));
    const truncated = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_B }), f.ctx);
    assert.equal(truncated.isError, true);
    assert.equal(envelopeOf(truncated).error.code, 'INVALID_ARGUMENT');
    await fs.writeFile(path.join(f.captures, `${ID_C}.png`), 'this is not a png file');
    const nonPng = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_C }), f.ctx);
    assert.equal(nonPng.isError, true);
    assert.equal(envelopeOf(nonPng).error.code, 'INVALID_ARGUMENT');
    assert.match(envelopeOf(nonPng).error.message, /valid PNG/i);
  } finally { await f.cleanup(); }
});

test('unsupported PNG encodings are rejected with a clear message', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    const bytes = Buffer.from(await fs.readFile(path.join(f.captures, `${ID_A}.png`)));
    bytes[25] = 0; // IHDR color type: RGBA -> grayscale (decoder skips CRC, so no recompute needed)
    await fs.writeFile(path.join(f.captures, `${ID_B}.png`), bytes);
    const result = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_B }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal(envelopeOf(result).error.code, 'INVALID_ARGUMENT');
    assert.match(envelopeOf(result).error.message, /8-bit RGB\/RGBA/i);
  } finally { await f.cleanup(); }
});

test('malformed ids and thresholds are INVALID_ARGUMENT at the dispatch boundary', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    const tools = buildToolRegistry(f.ctx);
    const badId = await dispatchToolCall(tools, 'capture_compare', { base: 'not-an-id', other: ID_A }, f.ctx);
    assert.equal(badId.isError, true);
    assert.equal((badId.structuredContent as Record<string, any>).error.code, 'INVALID_ARGUMENT');
    const badHost = await dispatchToolCall(tools, 'capture_compare', { base: `flax://asset/${ID_A}`, other: ID_A }, f.ctx);
    assert.equal((badHost.structuredContent as Record<string, any>).error.code, 'INVALID_ARGUMENT');
    const badThreshold = await dispatchToolCall(tools, 'capture_compare', { base: ID_A, other: ID_A, threshold: 2 }, f.ctx);
    assert.equal((badThreshold.structuredContent as Record<string, any>).error.code, 'INVALID_ARGUMENT');
    const missing = await dispatchToolCall(tools, 'capture_compare', { base: ID_C, other: ID_A }, f.ctx);
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as Record<string, any>).error.code, 'NOT_FOUND');
  } finally { await f.cleanup(); }
});

test('expired captures report not-found', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    await putPng(f.captures, ID_B, WIDE_W, WIDE_H);
    const backdated = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(path.join(f.captures, `${ID_B}.png`), backdated, backdated);
    const result = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_B }), f.ctx);
    assert.equal(result.isError, true);
    assert.equal(envelopeOf(result).error.code, 'NOT_FOUND');
    assert.match(envelopeOf(result).error.message, /expired|not found/i);
  } finally { await f.cleanup(); }
});

test('emit_diff writes a red-overlay PNG readable as a capture resource', async () => {
  const f = await fixture();
  try {
    await putPng(f.captures, ID_A, WIDE_W, WIDE_H);
    const rgba = gradientRgba(WIDE_W, WIDE_H);
    rgba[0] = 255 - rgba[0];
    await fs.writeFile(path.join(f.captures, `${ID_C}.png`), encodePngRgba(WIDE_W, WIDE_H, rgba));
    const result = await handleCaptureCompare(
      CaptureCompareSchema.parse({ base: ID_A, other: ID_C, threshold: 0, emit_diff: true }), f.ctx);
    const data = envelopeOf(result).data;
    assert.equal(data.match, false);
    assert.equal(data.diff_pixels, 1);
    assert.match(data.diff_uri, /^flax:\/\/capture\/[0-9a-f]{32}$/);
    const read = await readFlaxResource(data.diff_uri, f.ctx);
    assert.equal(read.contents[0].mimeType, 'image/png');
    const diffDecoded = decodePng(Buffer.from(read.contents[0].blob, 'base64'));
    assert.equal(diffDecoded.width, WIDE_W);
    assert.equal(diffDecoded.height, WIDE_H);
    assert.deepEqual(Array.from(diffDecoded.pixels.subarray(0, 4)), [255, 0, 0, 255]);
  } finally { await f.cleanup(); }
});

test('capture_compare is a read-family tool', () => {
  assert.equal(isToolAllowed('capture_compare', { profile: 'read-only', allowTools: [], denyTools: [], emergencyReadOnly: false }), true);
  assert.equal(isToolAllowed('capture_compare', { profile: 'full', allowTools: [], denyTools: [], emergencyReadOnly: true }), true);
});
