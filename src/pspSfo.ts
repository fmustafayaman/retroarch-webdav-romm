/**
 * Minimal parser for the PSP's PARAM.SFO ("PSF") format — the file
 * PPSSPP writes into every save folder (`PSP/SAVEDATA/<slot>/PARAM.SFO`)
 * describing that save. We only need two of its fields: DISC_ID (the
 * game's serial, e.g. "ULUS10336") and TITLE (the game's display name),
 * to resolve a save folder to a RomM rom — see pspSave.ts.
 *
 * Format (well-documented, no official spec but stable across the PSP/PS3
 * ecosystem): a 20-byte header, followed by a fixed-size index table (one
 * 16-byte entry per key), a key table (NUL-terminated ASCII strings), and
 * a data table (UTF-8 strings or little-endian integers, per entry).
 */
export function parseSfo(buf: Buffer): Record<string, string | number> {
  if (buf.length < 20 || buf.toString("ascii", 0, 4) !== "\0PSF") {
    throw new Error("Not a PARAM.SFO file (bad magic)");
  }

  const keyTableOffset = buf.readUInt32LE(8);
  const dataTableOffset = buf.readUInt32LE(12);
  const entryCount = buf.readUInt32LE(16);

  const result: Record<string, string | number> = {};

  for (let i = 0; i < entryCount; i++) {
    const entryOffset = 20 + i * 16;
    const keyOffset = buf.readUInt16LE(entryOffset);
    const dataFmt = buf.readUInt16LE(entryOffset + 2);
    const dataLen = buf.readUInt32LE(entryOffset + 8);
    const dataOffset = buf.readUInt32LE(entryOffset + 12);

    const keyStart = keyTableOffset + keyOffset;
    const keyEnd = buf.indexOf(0, keyStart);
    const key = buf.toString("ascii", keyStart, keyEnd === -1 ? undefined : keyEnd);

    const valueStart = dataTableOffset + dataOffset;
    const rawValue = buf.subarray(valueStart, valueStart + dataLen);

    // 0x0404 = int32, 0x0204/0x0402 = UTF-8 string (NUL-padded/terminated).
    if (dataFmt === 0x0404) {
      result[key] = dataLen >= 4 ? rawValue.readInt32LE(0) : 0;
    } else {
      const nul = rawValue.indexOf(0);
      result[key] = rawValue.toString("utf8", 0, nul === -1 ? undefined : nul);
    }
  }

  return result;
}
