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

// Real viewport captures. Copied read-only into temp fixtures; never modified.
const REAL_CAPTURES = 'D:/Code/flax/flax-playback/Cache/MCP/captures';
const REAL_WIDE = '5062dc72739a46af8053f38588e1b3d6.png'; // 1920x1048 RGBA
const REAL_TALL = '62293ad3240b4322bfae755d51f0f25c.png'; // 1091x653 RGBA

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
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_B}.png`));
    const result = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_B }), f.ctx);
    assert.equal(result.isError, undefined);
    const envelope = envelopeOf(result);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.match, true);
    assert.equal(envelope.data.width, 1920);
    assert.equal(envelope.data.height, 1048);
    assert.equal(envelope.data.diff_pixels, 0);
    assert.equal(envelope.data.diff_fraction, 0);
    assert.equal(envelope.data.max_channel_diff, 0);
    assert.equal('diff_uri' in envelope.data, false);
  } finally { await f.cleanup(); }
});

test('modified real capture reports sane diff counts and honours the threshold', async () => {
  const f = await fixture();
  try {
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
    const decoded = decodePng(await fs.readFile(path.join(REAL_CAPTURES, REAL_WIDE)));
    const pixels = Buffer.from(decoded.pixels);
    const changed = 7;
    for (let i = 0; i < changed; i += 1) {
      pixels[i * decoded.channels] = 255 - pixels[i * decoded.channels];
      pixels[i * decoded.channels + 1] = 255;
      pixels[i * decoded.channels + 2] = 0;
    }
    const rgba = Buffer.alloc(decoded.width * decoded.height * 4);
    for (let i = 0; i < decoded.width * decoded.height; i += 1) {
      rgba[i * 4] = pixels[i * decoded.channels];
      rgba[i * 4 + 1] = pixels[i * decoded.channels + 1];
      rgba[i * 4 + 2] = pixels[i * decoded.channels + 2];
      rgba[i * 4 + 3] = decoded.channels === 4 ? pixels[i * 4 + 3] : 255;
    }
    await fs.writeFile(path.join(f.captures, `${ID_C}.png`), encodePngRgba(decoded.width, decoded.height, rgba));
    const strict = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_C, threshold: 0 }), f.ctx);
    const strictData = envelopeOf(strict).data;
    assert.equal(strictData.match, false);
    assert.equal(strictData.width, 1920);
    assert.equal(strictData.height, 1048);
    assert.equal(strictData.diff_pixels, changed);
    assert.equal(strictData.diff_fraction, changed / (1920 * 1048));
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
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_TALL), path.join(f.captures, `${ID_B}.png`));
    const result = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_B }), f.ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(envelopeOf(result).data, {
      match: false,
      reason: 'dimension_mismatch',
      base: { width: 1920, height: 1048 },
      other: { width: 1091, height: 653 },
    });
  } finally { await f.cleanup(); }
});

test('crafted minimal PNG of a different size reports dimension_mismatch', async () => {
  const f = await fixture();
  try {
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
    await fs.writeFile(path.join(f.captures, `${ID_D}.png`), encodePngRgba(4, 3, Buffer.alloc(4 * 3 * 4, 128)));
    const result = await handleCaptureCompare(CaptureCompareSchema.parse({ base: ID_A, other: ID_D }), f.ctx);
    assert.deepEqual(envelopeOf(result).data, {
      match: false,
      reason: 'dimension_mismatch',
      base: { width: 1920, height: 1048 },
      other: { width: 4, height: 3 },
    });
  } finally { await f.cleanup(); }
});

test('URI and bare-id references are both accepted', async () => {
  const f = await fixture();
  try {
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_B}.png`));
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
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
    const full = await fs.readFile(path.join(REAL_CAPTURES, REAL_WIDE));
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
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
    const bytes = Buffer.from(await fs.readFile(path.join(REAL_CAPTURES, REAL_WIDE)));
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
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
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
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_B}.png`));
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
    await fs.copyFile(path.join(REAL_CAPTURES, REAL_WIDE), path.join(f.captures, `${ID_A}.png`));
    const decoded = decodePng(await fs.readFile(path.join(REAL_CAPTURES, REAL_WIDE)));
    const rgba = Buffer.alloc(decoded.width * decoded.height * 4);
    for (let i = 0; i < decoded.width * decoded.height; i += 1) {
      rgba[i * 4] = decoded.pixels[i * decoded.channels];
      rgba[i * 4 + 1] = decoded.pixels[i * decoded.channels + 1];
      rgba[i * 4 + 2] = decoded.pixels[i * decoded.channels + 2];
      rgba[i * 4 + 3] = decoded.channels === 4 ? decoded.pixels[i * 4 + 3] : 255;
    }
    rgba[0] = 255 - rgba[0];
    await fs.writeFile(path.join(f.captures, `${ID_C}.png`), encodePngRgba(decoded.width, decoded.height, rgba));
    const result = await handleCaptureCompare(
      CaptureCompareSchema.parse({ base: ID_A, other: ID_C, threshold: 0, emit_diff: true }), f.ctx);
    const data = envelopeOf(result).data;
    assert.equal(data.match, false);
    assert.equal(data.diff_pixels, 1);
    assert.match(data.diff_uri, /^flax:\/\/capture\/[0-9a-f]{32}$/);
    const read = await readFlaxResource(data.diff_uri, f.ctx);
    assert.equal(read.contents[0].mimeType, 'image/png');
    const diffDecoded = decodePng(Buffer.from(read.contents[0].blob, 'base64'));
    assert.equal(diffDecoded.width, 1920);
    assert.equal(diffDecoded.height, 1048);
    assert.deepEqual(Array.from(diffDecoded.pixels.subarray(0, 4)), [255, 0, 0, 255]);
  } finally { await f.cleanup(); }
});

test('capture_compare is a read-family tool', () => {
  assert.equal(isToolAllowed('capture_compare', { profile: 'read-only', allowTools: [], denyTools: [], emergencyReadOnly: false }), true);
  assert.equal(isToolAllowed('capture_compare', { profile: 'full', allowTools: [], denyTools: [], emergencyReadOnly: true }), true);
});
