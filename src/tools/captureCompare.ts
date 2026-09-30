import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import { z } from 'zod';
import { ProjectMeta } from '../projectContext.js';
import { ToolDomainError, toolError, toolResult, ToolResponse } from '../errors.js';
import { CaptureTtlMs, MaxCaptureBytes, canonicalCaptureDirectory, confinedCaptureFile } from '../resources.js';

const CaptureRef = z.string().regex(
  /^(flax:\/\/capture\/)?[0-9a-fA-F]{32}$/,
  'Expected a flax://capture/<id> URI or a bare 32-hex capture id.',
);

export const CaptureCompareSchema = z.object({
  base: CaptureRef,
  other: CaptureRef,
  threshold: z.number().min(0).max(1).optional().default(0.01),
  emit_diff: z.boolean().optional().default(false),
});

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function invalid(message: string, details?: unknown): ToolDomainError {
  return new ToolDomainError('INVALID_ARGUMENT', message, details);
}

function notFound(message: string): ToolDomainError {
  return new ToolDomainError('NOT_FOUND', message);
}

function captureIdOf(ref: string): string {
  const id = ref.startsWith('flax://capture/') ? ref.slice('flax://capture/'.length) : ref;
  if (!/^[0-9a-fA-F]{32}$/.test(id)) throw invalid(`Invalid capture reference "${ref.slice(0, 64)}". Expected a flax://capture/<id> URI or a bare 32-hex capture id.`);
  return id;
}

async function readConfinedCapture(id: string, ctx: ProjectMeta): Promise<Buffer> {
  let directory: string;
  try {
    directory = await canonicalCaptureDirectory(ctx);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('Capture resource was not found or has expired.');
    throw error;
  }
  let file: string;
  let statSize: number;
  let statMtimeMs: number;
  try {
    const confined = await confinedCaptureFile(directory, id);
    file = confined.file;
    statSize = Number(confined.stat.size);
    statMtimeMs = Number(confined.stat.mtimeMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('Capture resource was not found or has expired.');
    throw error;
  }
  if (statSize <= 0 || statSize > MaxCaptureBytes || Date.now() - statMtimeMs > CaptureTtlMs) {
    throw notFound('Capture resource was not found or has expired.');
  }
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || Number(opened.size) !== statSize || Number(opened.size) > MaxCaptureBytes) {
      throw notFound('Capture resource was not found or has expired.');
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

function readChunk(buffer: Buffer, offset: number): { type: string; data: Buffer; next: number } {
  if (offset + 8 > buffer.length) throw invalid('Capture PNG is truncated or corrupt: incomplete chunk header.');
  const length = buffer.readUInt32BE(offset);
  const type = buffer.toString('ascii', offset + 4, offset + 8);
  if (length > MaxCaptureBytes || offset + 12 + length > buffer.length) {
    throw invalid('Capture PNG is truncated or corrupt: chunk overruns the file.');
  }
  return { type, data: buffer.subarray(offset + 8, offset + 8 + length), next: offset + 12 + length };
}

/** Minimal dependency-free PNG decoder: non-interlaced 8-bit RGB/RGBA only. */
export function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw invalid('Capture resource is not a valid PNG file.');
  }
  let width = 0;
  let height = 0;
  let channels = 0;
  let seenIhdr = false;
  let seenIend = false;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset < buffer.length) {
    const { type, data, next } = readChunk(buffer, offset);
    offset = next;
    if (!seenIhdr) {
      if (type !== 'IHDR') throw invalid('Capture PNG is corrupt: IHDR must be the first chunk.');
      if (data.length !== 13) throw invalid('Capture PNG is corrupt: malformed IHDR chunk.');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (compression !== 0 || filter !== 0) throw invalid('Unsupported PNG encoding: only standard deflate/filter encodings are supported.');
      if (interlace !== 0) throw invalid('Unsupported PNG: interlaced captures are not supported (non-interlaced 8-bit RGB/RGBA only).');
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw invalid(`Unsupported PNG format: bit depth ${bitDepth}, color type ${colorType}. Only non-interlaced 8-bit RGB/RGBA captures are supported.`);
      }
      if (width === 0 || height === 0 || width > 16384 || height > 16384) {
        throw invalid(`Unsupported PNG dimensions: ${width}x${height}.`);
      }
      channels = colorType === 6 ? 4 : 3;
      seenIhdr = true;
      continue;
    }
    if (type === 'IDAT') {
      if (data.length > 0) idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      seenIend = true;
      break;
    }
  }
  if (!seenIhdr) throw invalid('Capture PNG is corrupt: missing IHDR chunk.');
  if (!seenIend) throw invalid('Capture PNG is truncated or corrupt: missing IEND chunk.');
  if (idat.length === 0) throw invalid('Capture PNG is corrupt: missing image data.');
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw invalid('Capture PNG is truncated or corrupt: image data failed to decompress.');
  }
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) {
    throw invalid('Capture PNG is truncated or corrupt: decompressed scanlines do not match IHDR dimensions.');
  }
  const pixels = Buffer.alloc(height * stride);
  const prev = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    if (filterType > 4) throw invalid('Capture PNG is corrupt: unknown scanline filter.');
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? current[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let value: number;
      switch (filterType) {
        case 0: value = line[x]; break;
        case 1: value = (line[x] + a) & 0xff; break;
        case 2: value = (line[x] + b) & 0xff; break;
        case 3: value = (line[x] + ((a + b) >> 1)) & 0xff; break;
        default: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
      }
      current[x] = value;
    }
    current.copy(pixels, y * stride);
    current.copy(prev);
  }
  return { width, height, channels, pixels };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
  return Buffer.concat([header, data, crc]);
}

/** Minimal dependency-free RGBA PNG encoder (filter 0) for diff output and tests. */
export function encodePngRgba(width: number, height: number, pixels: Buffer): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}.`);
  }
  if (pixels.length !== width * height * 4) throw new Error('Pixel buffer does not match RGBA dimensions.');
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    pixels.subarray(y * stride, (y + 1) * stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const compressed = deflateSync(raw);
  return Buffer.concat([PNG_MAGIC, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

export async function handleCaptureCompare(args: z.infer<typeof CaptureCompareSchema>, ctx: ProjectMeta): Promise<ToolResponse> {
  try {
    const baseId = captureIdOf(args.base);
    const otherId = captureIdOf(args.other);
    const [baseBytes, otherBytes] = await Promise.all([
      readConfinedCapture(baseId, ctx),
      readConfinedCapture(otherId, ctx),
    ]);
    const base = decodePng(baseBytes);
    const other = decodePng(otherBytes);
    if (base.width !== other.width || base.height !== other.height) {
      const data = {
        match: false,
        reason: 'dimension_mismatch',
        base: { width: base.width, height: base.height },
        other: { width: other.width, height: other.height },
      };
      return toolResult(JSON.stringify(data, null, 2), { data });
    }
    const total = base.width * base.height;
    let diffPixels = 0;
    let maxChannelDiff = 0;
    for (let i = 0; i < total; i += 1) {
      let differs = false;
      for (let c = 0; c < 3; c += 1) {
        const delta = Math.abs(base.pixels[i * base.channels + c] - other.pixels[i * other.channels + c]);
        if (delta > 0) differs = true;
        if (delta > maxChannelDiff) maxChannelDiff = delta;
      }
      const baseAlpha = base.channels === 4 ? base.pixels[i * 4 + 3] : 255;
      const otherAlpha = other.channels === 4 ? other.pixels[i * 4 + 3] : 255;
      const alphaDelta = Math.abs(baseAlpha - otherAlpha);
      if (alphaDelta > 0) differs = true;
      if (alphaDelta > maxChannelDiff) maxChannelDiff = alphaDelta;
      if (differs) diffPixels += 1;
    }
    const diffFraction = total === 0 ? 0 : diffPixels / total;
    const data: Record<string, unknown> = {
      match: diffFraction <= args.threshold,
      width: base.width,
      height: base.height,
      diff_pixels: diffPixels,
      diff_fraction: diffFraction,
      max_channel_diff: maxChannelDiff,
    };
    if (args.emit_diff) {
      const overlay = Buffer.alloc(total * 4);
      for (let i = 0; i < total; i += 1) {
        let differs = false;
        for (let c = 0; c < 4; c += 1) {
          const left = c < 3 || base.channels === 4 ? base.pixels[i * base.channels + c] : 255;
          const right = c < 3 || other.channels === 4 ? other.pixels[i * other.channels + c] : 255;
          if (left !== right) { differs = true; break; }
        }
        if (differs) {
          overlay[i * 4] = 255;
          overlay[i * 4 + 1] = 0;
          overlay[i * 4 + 2] = 0;
          overlay[i * 4 + 3] = 255;
        } else {
          overlay[i * 4] = base.pixels[i * base.channels];
          overlay[i * 4 + 1] = base.pixels[i * base.channels + 1];
          overlay[i * 4 + 2] = base.pixels[i * base.channels + 2];
          overlay[i * 4 + 3] = base.channels === 4 ? base.pixels[i * 4 + 3] : 255;
        }
      }
      const directory = await canonicalCaptureDirectory(ctx);
      const diffId = randomBytes(16).toString('hex');
      const confined = path.join(directory, `${diffId}.png`);
      const resolved = path.resolve(confined);
      const relative = path.relative(directory, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw invalid('Capture diff escapes the project cache.');
      await fs.writeFile(resolved, encodePngRgba(base.width, base.height, overlay), { flag: 'wx' });
      data.diff_uri = `flax://capture/${diffId}`;
    }
    return toolResult(JSON.stringify(data, null, 2), { data });
  } catch (error) {
    return toolError(error);
  }
}
