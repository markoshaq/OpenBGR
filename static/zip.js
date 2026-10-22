/**
 * STORED-ZIP packaging: an in-memory archive builder for small results sets
 * and a streaming writer for FileSystemWritableFileStream. Image payloads
 * are already compressed, so store-only avoids extra CPU passes.
 * This module has no imports and no side effects; it is pure byte math.
 */

const ZIP_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Computes a CRC-32 checksum for ZIP central-directory entries. */
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    c = ZIP_CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const ZIP_ENCODER = new TextEncoder();
// STORED-ZIP header fields are uint32 offsets and a uint16 entry count;
// silently truncating past them yields a corrupt archive.
const ZIP_U32_MAX = 0xffffffff;
const ZIP_U16_MAX = 0xffff;
const ZIP_TOO_LARGE_MSG =
  "Batch exceeds the 4 GiB ZIP limit; save to an output folder instead.";

/** Builds the 30-byte local header plus UTF-8 name bytes for one STORED entry. */
function zipLocalPieces(name, data) {
  const nameBytes = ZIP_ENCODER.encode(name);
  // Bit 11 marks the entry name as UTF-8; without it, extractors assume
  // CP437 and non-ASCII filenames come out as mojibake.
  const utf8Flag = nameBytes.length !== name.length ? 0x0800 : 0;
  const crc = crc32(data);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(6, utf8Flag, true);
  local.setUint16(8, 0, true);
  local.setUint16(10, 0, true);
  local.setUint16(12, 0, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, nameBytes.length, true);
  local.setUint16(28, 0, true);
  return { local: local.buffer, nameBytes, crc, size: data.length, utf8Flag };
}

/** Builds the 46-byte central-directory record for a written entry. */
function zipCentralRecord(e) {
  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true);
  cd.setUint16(4, 20, true);
  cd.setUint16(6, 20, true);
  cd.setUint16(8, e.utf8Flag, true);
  cd.setUint16(10, 0, true);
  cd.setUint16(12, 0, true);
  cd.setUint16(14, 0, true);
  cd.setUint32(16, e.crc, true);
  cd.setUint32(20, e.size, true);
  cd.setUint32(24, e.size, true);
  cd.setUint16(28, e.nameBytes.length, true);
  cd.setUint32(42, e.offset, true);
  return cd.buffer;
}

/** Builds the 22-byte end-of-central-directory record. */
function zipEocd(count, cdSize, cdStart) {
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, count, true);
  eocd.setUint16(10, count, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  return eocd.buffer;
}

/**
 * Builds an uncompressed (STORED) ZIP archive in memory. Image payloads are
 * already compressed, so store-only avoids extra CPU passes with no size cost.
 */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    if (offset > ZIP_U32_MAX || data.length > ZIP_U32_MAX) {
      throw new Error(ZIP_TOO_LARGE_MSG);
    }
    const p = zipLocalPieces(name, data);
    chunks.push(p.local, p.nameBytes, data);
    central.push({
      nameBytes: p.nameBytes,
      crc: p.crc,
      size: p.size,
      offset,
      utf8Flag: p.utf8Flag,
    });
    offset += 30 + p.nameBytes.length + p.size;
  }

  const cdStart = offset;
  for (const e of central) {
    chunks.push(zipCentralRecord(e), e.nameBytes);
    offset += 46 + e.nameBytes.length;
  }
  if (
    central.length > ZIP_U16_MAX ||
    offset - cdStart > ZIP_U32_MAX ||
    cdStart > ZIP_U32_MAX
  ) {
    throw new Error(ZIP_TOO_LARGE_MSG);
  }

  chunks.push(zipEocd(central.length, offset - cdStart, cdStart));
  return new Blob(chunks, { type: "application/zip" });
}

/**
 * Incremental STORED-zip writer for a FileSystemWritableFileStream. Each
 * entry is flushed to disk as it is produced, so a large batch holds at most
 * one output file's bytes in memory at a time.
 */
export function createZipWriter(writable) {
  const central = [];
  const names = new Set();
  let offset = 0;
  return {
    names,
    async add(name, data) {
      if (offset > ZIP_U32_MAX || data.length > ZIP_U32_MAX) {
        throw new Error(ZIP_TOO_LARGE_MSG);
      }
      const p = zipLocalPieces(name, data);
      await writable.write(p.local);
      await writable.write(p.nameBytes);
      await writable.write(data);
      central.push({
        nameBytes: p.nameBytes,
        crc: p.crc,
        size: p.size,
        offset,
        utf8Flag: p.utf8Flag,
      });
      offset += 30 + p.nameBytes.length + p.size;
    },
    async close() {
      const cdStart = offset;
      let cdSize = 0;
      for (const e of central) cdSize += 46 + e.nameBytes.length;
      if (
        central.length > ZIP_U16_MAX ||
        cdSize > ZIP_U32_MAX ||
        cdStart > ZIP_U32_MAX
      ) {
        try {
          await writable.abort();
        } catch (_) {}
        throw new Error(ZIP_TOO_LARGE_MSG);
      }
      for (const e of central) {
        await writable.write(zipCentralRecord(e));
        await writable.write(e.nameBytes);
      }
      await writable.write(zipEocd(central.length, cdSize, cdStart));
      await writable.close();
    },
    async abort() {
      try {
        await writable.abort();
      } catch (_) {}
    },
  };
}
