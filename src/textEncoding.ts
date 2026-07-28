import fs from 'node:fs/promises';

function looksLikeUtf16Le(buffer: Buffer): boolean {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return true;
  const sampleSize = Math.min(buffer.length, 4096);
  if (sampleSize < 4) return false;

  let oddNulls = 0;
  let oddBytes = 0;
  for (let i = 1; i < sampleSize; i += 2) {
    oddBytes++;
    if (buffer[i] === 0) oddNulls++;
  }
  return oddBytes > 0 && oddNulls / oddBytes > 0.3;
}

function looksLikeUtf16Be(buffer: Buffer): boolean {
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return true;
  const sampleSize = Math.min(buffer.length, 4096);
  if (sampleSize < 4) return false;

  let evenNulls = 0;
  let evenBytes = 0;
  for (let i = 0; i < sampleSize; i += 2) {
    evenBytes++;
    if (buffer[i] === 0) evenNulls++;
  }
  return evenBytes > 0 && evenNulls / evenBytes > 0.3;
}

export function decodeText(buffer: Buffer): string {
  if (looksLikeUtf16Le(buffer)) {
    const offset = buffer[0] === 0xff && buffer[1] === 0xfe ? 2 : 0;
    return buffer.subarray(offset).toString('utf16le').replace(/^\uFEFF/, '');
  }
  if (looksLikeUtf16Be(buffer)) {
    const offset = buffer[0] === 0xfe && buffer[1] === 0xff ? 2 : 0;
    const data = Buffer.from(buffer.subarray(offset));
    if (data.length % 2 !== 0) return data.toString('utf8').replace(/^\uFEFF/, '');
    data.swap16();
    return data.toString('utf16le').replace(/^\uFEFF/, '');
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

export async function readTextFile(filePath: string): Promise<string> {
  return decodeText(await fs.readFile(filePath));
}
