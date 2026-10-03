/**
 * GUID forms used around a Flax project.
 *
 * - managed "N": .NET `Guid.ToString("N")`. This is what the Editor bridge returns and accepts.
 *   Bytes 0..3 are printed as a big-endian Data1 and bytes 4..7 as two big-endian shorts, i.e. the
 *   layout of `new Guid(byte[16])` over the raw header bytes of a binary `.flax` asset.
 * - native "N": the engine's own text form (`.scene`/`.prefab`/`.json` content, `Register asset` log).
 *   Four uint32 words A,B,C,D printed `%08x` each. Versus managed: the two shorts of the second word
 *   are swapped and each four-byte half of Data4 is byte-reversed.
 *
 * Raw header bytes (`CFWF` header, offset 0x1c, 16 bytes) are the four little-endian uint32 words, so
 * native = each 4-byte group reversed, and managed = `new Guid(bytes)`.
 * See docs/GUID_AUDIT_P7.md (AR15: managed a2fbb23610c24133abe253a0c8d1839c <-> native a2fbb236413310c2a053e2ab9c83d1c8).
 */

const HEX32 = /^[0-9a-f]{32}$/i;

export function isGuidHex(value: unknown): value is string {
  return typeof value === 'string' && HEX32.test(value);
}

/** Accept "N", "D" (hyphenated), "B" ({...}) and "P" ((...)) spellings; returns lowercase 32 hex or null. */
export function normalizeGuidInput(value: string): string | null {
  const trimmed = value.trim();
  const stripped = /^\{.*\}$/.test(trimmed) || /^\(.*\)$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  const compact = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stripped) ? stripped.replaceAll('-', '') : stripped;
  return HEX32.test(compact) ? compact.toLowerCase() : null;
}

function requireHex32(value: string): string {
  if (!HEX32.test(value)) throw new RangeError(`Expected a 32-digit hexadecimal GUID, got "${value}".`);
  return value.toLowerCase();
}

/** The managed<->native transform is its own inverse: swap the shorts of word 2, reverse each word of the last 8 bytes. */
function swapForm(hex: string): string {
  const word = (start: number) => hex.slice(start, start + 8);
  const reverseBytes = (w: string) => w.match(/../g)!.reverse().join('');
  return word(0) + word(8).slice(4) + word(8).slice(0, 4) + reverseBytes(word(16)) + reverseBytes(word(24));
}

/** Engine text form (scene/prefab/json) to the bridge's .NET "N" form. */
export function nativeToManaged(hex32: string): string {
  return swapForm(requireHex32(hex32));
}

/** Bridge/.NET "N" form to the engine text form that scene/prefab/json files contain. */
export function managedToNative(hex32: string): string {
  return swapForm(requireHex32(hex32));
}

/** Raw 16 header bytes of a `.flax` file (offset 0x1c) to the bridge's .NET "N" form (`new Guid(byte[])`). */
export function headerBytesToManaged(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new RangeError('A GUID needs 16 bytes.');
  const b = Buffer.from(bytes.subarray(0, 16));
  return b.readUInt32LE(0).toString(16).padStart(8, '0')
    + b.readUInt16LE(4).toString(16).padStart(4, '0')
    + b.readUInt16LE(6).toString(16).padStart(4, '0')
    + b.subarray(8, 16).toString('hex');
}

/** Raw 16 header bytes to the engine text form. */
export function headerBytesToNative(bytes: Uint8Array): string {
  return managedToNative(headerBytesToManaged(bytes));
}

/** Text-file ID (native) to the form tools print; returns the input untouched when it is not a GUID. */
export function nativeToManagedLenient(value: string): string {
  return isGuidHex(value) ? nativeToManaged(value) : value;
}
