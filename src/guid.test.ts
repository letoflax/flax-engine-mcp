import assert from 'node:assert/strict';
import test from 'node:test';
import {
  headerBytesToManaged,
  headerBytesToNative,
  isGuidHex,
  managedToNative,
  nativeToManaged,
  nativeToManagedLenient,
  normalizeGuidInput,
} from './guid.js';

// docs/GUID_AUDIT_P7.md: header bytes, managed (bridge) form and native (scene text) form.
const VECTORS = [
  { header: '36b2fba2c2103341abe253a0c8d1839c', managed: 'a2fbb23610c24133abe253a0c8d1839c', native: 'a2fbb236413310c2a053e2ab9c83d1c8' },
  { header: '52848ba611731d4189970aab3dd3e5b4', managed: 'a68b84527311411d89970aab3dd3e5b4', native: 'a68b8452411d7311ab0a9789b4e5d33d' },
  { header: '576c1ed066866f40aa042b6db4b49c1b', managed: 'd01e6c578666406faa042b6db4b49c1b', native: 'd01e6c57406f86666d2b04aa1b9cb4b4' },
];

test('AR15 vectors convert in both directions', () => {
  for (const v of VECTORS) {
    assert.equal(nativeToManaged(v.native), v.managed);
    assert.equal(managedToNative(v.managed), v.native);
  }
});

test('raw header bytes map to managed and native forms', () => {
  for (const v of VECTORS) {
    assert.equal(headerBytesToManaged(Buffer.from(v.header, 'hex')), v.managed);
    assert.equal(headerBytesToNative(Buffer.from(v.header, 'hex')), v.native);
  }
  assert.equal(headerBytesToManaged(Buffer.from('00112233445566778899aabbccddeeff', 'hex')), '33221100554477668899aabbccddeeff');
  assert.throws(() => headerBytesToManaged(Buffer.alloc(8)), RangeError);
});

test('conversions round-trip for arbitrary GUIDs and keep lowercase 32 hex', () => {
  for (let i = 0; i < 200; i++) {
    const hex = Buffer.from(Array.from({ length: 16 }, (_, j) => (i * 37 + j * 91 + (i * j) % 251) & 0xff)).toString('hex');
    assert.equal(nativeToManaged(managedToNative(hex)), hex);
    assert.equal(managedToNative(nativeToManaged(hex)), hex);
    assert.match(managedToNative(hex), /^[0-9a-f]{32}$/);
  }
  assert.equal(nativeToManaged('A2FBB236413310C2A053E2AB9C83D1C8'), 'a2fbb23610c24133abe253a0c8d1839c');
});

test('invalid input is rejected or passed through only by the lenient helper', () => {
  assert.throws(() => nativeToManaged('xyz'), RangeError);
  assert.throws(() => managedToNative('a2fbb236'), RangeError);
  assert.equal(nativeToManagedLenient('not-a-guid'), 'not-a-guid');
  assert.equal(nativeToManagedLenient(VECTORS[0]!.native), VECTORS[0]!.managed);
  assert.equal(isGuidHex(VECTORS[0]!.managed), true);
  assert.equal(isGuidHex('abc'), false);
});

test('normalizeGuidInput accepts N, D, braced and parenthesised spellings', () => {
  const n = VECTORS[0]!.managed;
  const d = `${n.slice(0, 8)}-${n.slice(8, 12)}-${n.slice(12, 16)}-${n.slice(16, 20)}-${n.slice(20)}`;
  assert.equal(normalizeGuidInput(n.toUpperCase()), n);
  assert.equal(normalizeGuidInput(d), n);
  assert.equal(normalizeGuidInput(`{${d}}`), n);
  assert.equal(normalizeGuidInput(`(${d})`), n);
  assert.equal(normalizeGuidInput('nope'), null);
});
