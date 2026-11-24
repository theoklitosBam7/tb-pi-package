/** Return Buffer input unchanged. Encode strings as UTF-8 and copy other byte arrays. */
export function toBuffer(chunk: string | Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}
