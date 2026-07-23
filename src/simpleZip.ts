/**
 * Minimal ZIP reader/writer, "store" method only (no compression).
 *
 * Used to bundle a PSP save folder's several small files (PARAM.SFO, the
 * actual save data, ICON0.PNG, PIC1.PNG, ...) into a single RomM asset —
 * see pspSave.ts. Everything here only ever reads/writes zips this file
 * itself created, so it only implements exactly the subset of the ZIP
 * format needed for that: no compression (files are a few KB-MB, storing
 * uncompressed costs nothing meaningful and avoids pulling in a
 * compression dependency), no multi-disk, no encryption.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(buf: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const centralDirParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // compression: store
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date (arbitrary valid date)
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.length, 18); // compressed size
    localHeader.writeUInt32LE(entry.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    parts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIR_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // compression
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x21, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralDirParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + entry.data.length;
  }

  const centralDirStart = offset;
  const centralDir = Buffer.concat(centralDirParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIR_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(centralDirStart, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralDir, eocd]);
}

export function readZip(buf: Buffer): ZipEntry[] {
  // Locate End Of Central Directory by scanning back from the end (no
  // zip comment is ever written here, so it's always the last 22 bytes).
  const eocdOffset = buf.length - 22;
  if (eocdOffset < 0 || buf.readUInt32LE(eocdOffset) !== END_OF_CENTRAL_DIR_SIGNATURE) {
    throw new Error("Not a valid zip (missing end of central directory)");
  }
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  let centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(centralDirOffset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error("Corrupt zip central directory");
    }
    const compressedSize = buf.readUInt32LE(centralDirOffset + 20);
    const nameLen = buf.readUInt16LE(centralDirOffset + 28);
    const extraLen = buf.readUInt16LE(centralDirOffset + 30);
    const commentLen = buf.readUInt16LE(centralDirOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(centralDirOffset + 42);
    const name = buf.toString("utf8", centralDirOffset + 46, centralDirOffset + 46 + nameLen);

    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize);

    entries.push({ name, data: Buffer.from(data) });
    centralDirOffset += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
