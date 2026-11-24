export function toBuffer(chunk: string | Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}
