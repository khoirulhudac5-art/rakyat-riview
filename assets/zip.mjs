// Standalone ZIP (PKZip) generator for bulk QR Code exports.
// Stores files without external dependencies. Compatible with Windows Explorer, macOS, Linux, Android, iOS.

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  crcTable[n] = c;
}

export function crc32(uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < uint8Array.length; i++) {
    c = crcTable[(c ^ uint8Array[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function buildZip(files) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const dataBytes = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // Local file header (30 bytes + filename)
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); // Local file header signature
    view.setUint16(4, 20, true);         // Version needed to extract (2.0)
    view.setUint16(6, 0x0800, true);     // General purpose bit flag: UTF-8
    view.setUint16(8, 0, true);          // Compression method: 0 (store)
    view.setUint16(10, 0, true);         // Last mod time
    view.setUint16(12, 0, true);         // Last mod date
    view.setUint32(14, crc, true);       // CRC-32
    view.setUint32(18, size, true);      // Compressed size
    view.setUint32(22, size, true);      // Uncompressed size
    view.setUint16(26, nameBytes.length, true); // File name length
    view.setUint16(28, 0, true);         // Extra field length
    local.set(nameBytes, 30);

    chunks.push(local, dataBytes);

    // Central directory file header (46 bytes + filename)
    const central = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(central.buffer);
    cView.setUint32(0, 0x02014b50, true); // Central header signature
    cView.setUint16(4, 20, true);         // Version made by
    cView.setUint16(6, 20, true);         // Version needed to extract
    cView.setUint16(8, 0x0800, true);     // UTF-8 flag
    cView.setUint16(10, 0, true);         // Compression method: store
    cView.setUint16(12, 0, true);         // Last mod time
    cView.setUint14 = 0;
    cView.setUint16(14, 0, true);         // Last mod date
    cView.setUint32(16, crc, true);       // CRC-32
    cView.setUint32(20, size, true);      // Compressed size
    cView.setUint32(24, size, true);      // Uncompressed size
    cView.setUint16(28, nameBytes.length, true); // Filename length
    cView.setUint16(30, 0, true);         // Extra field length
    cView.setUint16(32, 0, true);         // Comment length
    cView.setUint16(34, 0, true);         // Disk number start
    cView.setUint16(36, 0, true);         // Internal file attributes
    cView.setUint32(38, 0, true);         // External file attributes
    cView.setUint32(42, offset, true);    // Relative offset of local header
    central.set(nameBytes, 46);

    centralDirectory.push(central);
    offset += local.length + dataBytes.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralDirectory) centralSize += c.length;

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eView = new DataView(eocd.buffer);
  eView.setUint32(0, 0x06054b50, true);            // EOCD signature
  eView.setUint16(4, 0, true);                     // Disk number
  eView.setUint16(6, 0, true);                     // Start disk number
  eView.setUint16(8, files.length, true);          // Entries on this disk
  eView.setUint16(10, files.length, true);         // Total entries
  eView.setUint32(12, centralSize, true);          // Size of central dir
  eView.setUint32(16, centralOffset, true);        // Offset of central dir
  eView.setUint16(20, 0, true);                    // Comment length

  // Total zip byte length
  const totalLength = offset + centralSize + eocd.length;
  const zipBuffer = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    zipBuffer.set(chunk, pos);
    pos += chunk.length;
  }
  for (const c of centralDirectory) {
    zipBuffer.set(c, pos);
    pos += c.length;
  }
  zipBuffer.set(eocd, pos);

  return zipBuffer;
}
