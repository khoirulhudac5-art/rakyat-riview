// Standalone, zero-dependency QR Code generator (ISO/IEC 18004)
// Generates QR Code matrices and SVG/Canvas/PNG outputs for permanent card URLs.

const PAD0 = 0xEC;
const PAD1 = 0x11;

// Galois Field GF(256) tables for Reed-Solomon error correction
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  EXP[i + 255] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x & 128 ? 0x11D : 0);
}

function gmul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

// Pre-computed RS polynomials
function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], root);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsCompute(data, eccLength) {
  const gen = rsGeneratorPoly(eccLength);
  const res = new Uint8Array(eccLength);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    for (let j = 0; j < eccLength - 1; j++) {
      res[j] = res[j + 1] ^ gmul(gen[gen.length - 2 - j], factor);
    }
    res[eccLength - 1] = gmul(gen[0], factor);
  }
  return res;
}

// Version table for Error Correction Level M (15%)
// [version, totalCodewords, dataCodewords, ecCodewordsPerBlock, numBlocks]
const VERSION_TABLE_M = [
  null,
  [1, 26, 16, 10, 1], // v1: 21x21, max 14 bytes
  [2, 44, 28, 16, 1], // v2: 25x25, max 26 bytes
  [3, 70, 44, 26, 1], // v3: 29x29, max 42 bytes
  [4, 100, 64, 18, 2], // v4: 33x33, max 62 bytes (perfect for our 56-char /r/ URLs!)
  [5, 134, 86, 24, 2], // v5: 37x37, max 84 bytes
  [6, 172, 108, 16, 4], // v6: 41x41, max 106 bytes
  [7, 196, 124, 18, 4]  // v7: 45x45, max 122 bytes
];

// Alignment pattern locations for versions 1..7
const ALIGNMENT_LOCATIONS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38]
];

export function chooseVersion(byteLength, level = 'M') {
  for (let v = 1; v < VERSION_TABLE_M.length; v++) {
    const info = VERSION_TABLE_M[v];
    const dataCap = info[2] - 2; // 4-bit mode + 8-bit count = 12 bits -> 2 bytes overhead
    if (byteLength <= dataCap) return v;
  }
  return 7;
}

export function encodeData(text, version = 4) {
  const bytes = new TextEncoder().encode(text);
  const info = VERSION_TABLE_M[version];
  const maxDataCodewords = info[2];

  // 1. Bit buffer: Mode (0100 for Byte mode) + Length (8 bits for v1-9) + bytes
  const bits = [];
  const pushBits = (val, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8); // Character count (8 bits for v1-9)
  for (let i = 0; i < bytes.length; i++) {
    pushBits(bytes[i], 8);
  }

  // 2. Terminator (up to 4 zeros)
  const remainingBits = maxDataCodewords * 8 - bits.length;
  pushBits(0, Math.min(4, Math.max(0, remainingBits)));

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // 3. Convert to bytes
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    codewords.push(byte);
  }

  // 4. Pad bytes alternating 0xEC and 0x11
  let padToggle = 0;
  while (codewords.length < maxDataCodewords) {
    codewords.push(padToggle % 2 === 0 ? PAD0 : PAD1);
    padToggle++;
  }

  // 5. Split into blocks and compute EC
  const numBlocks = info[4];
  const ecPerBlock = info[3];
  const blockSize = Math.floor(codewords.length / numBlocks);
  const dataBlocks = [];
  const ecBlocks = [];

  for (let b = 0; b < numBlocks; b++) {
    const block = codewords.slice(b * blockSize, (b + 1) * blockSize);
    dataBlocks.push(block);
    ecBlocks.push(rsCompute(block, ecPerBlock));
  }

  // 6. Interleave data and EC
  const result = [];
  for (let i = 0; i < blockSize; i++) {
    for (let b = 0; b < numBlocks; b++) result.push(dataBlocks[b][i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) result.push(ecBlocks[b][i]);
  }

  return result;
}

export function createQrMatrix(text, version = 4) {
  const size = 17 + version * 4;
  const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1)); // -1 = unset

  const setModule = (r, c, val) => {
    if (r >= 0 && r < size && c >= 0 && c < size) matrix[r][c] = val ? 1 : 0;
  };

  // 1. Finder patterns at (0,0), (size-7, 0), (0, size-7)
  const drawFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const nr = row + r, nc = col + c;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        if (r === -1 || r === 7 || c === -1 || c === 7) {
          matrix[nr][nc] = 0; // Separator
        } else if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) {
          matrix[nr][nc] = 1;
        } else {
          matrix[nr][nc] = 0;
        }
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // 2. Alignment patterns
  const alignCoords = ALIGNMENT_LOCATIONS[version] || [];
  for (const r of alignCoords) {
    for (const c of alignCoords) {
      if (matrix[r][c] !== -1) continue; // Skip finder areas
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isBlack = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          matrix[r + dr][c + dc] = isBlack ? 1 : 0;
        }
      }
    }
  }

  // 3. Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const val = i % 2 === 0 ? 1 : 0;
    if (matrix[6][i] === -1) matrix[6][i] = val;
    if (matrix[i][6] === -1) matrix[i][6] = val;
  }

  // 4. Dark module
  matrix[size - 8][8] = 1;

  // 5. Reserve format info areas
  for (let i = 0; i < 9; i++) {
    if (matrix[8][i] === -1) matrix[8][i] = 0;
    if (matrix[i][8] === -1) matrix[i][8] = 0;
  }
  for (let i = size - 8; i < size; i++) {
    if (matrix[8][i] === -1) matrix[8][i] = 0;
    if (matrix[i][8] === -1) matrix[i][8] = 0;
  }

  // 6. Data placement (zig-zag 2 columns at a time from right to left)
  const codewords = encodeData(text, version);
  const bits = [];
  for (const cw of codewords) {
    for (let b = 7; b >= 0; b--) bits.push((cw >>> b) & 1);
  }

  let bitIdx = 0;
  let upwards = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--; // Skip vertical timing column
    const rows = [];
    if (upwards) {
      for (let r = size - 1; r >= 0; r--) rows.push(r);
    } else {
      for (let r = 0; r < size; r++) rows.push(r);
    }
    for (const r of rows) {
      for (let c of [right, right - 1]) {
        if (matrix[r][c] === -1) {
          matrix[r][c] = bitIdx < bits.length ? bits[bitIdx++] : 0;
        }
      }
    }
    upwards = !upwards;
  }

  // 7. Apply Mask Pattern 0: (row + col) % 2 === 0
  // Level M format bits for Mask 0: 0b101010000010010 ^ 0b101010000010010 = 0x5412 XOR
  // Standard format string for Level M, mask 0 is 0x5412 XORed with 0x5412 = 0, BCH code:
  // Level M (00), mask 0 (000): 00 000 -> BCH 10101 11111 00100 -> XOR 10101 00000 10010 = 00000 11111 10110
  const formatBits = [1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0]; // Pre-calculated M0 format pattern

  // Apply mask to data modules
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      // Is data module? Check if not a fixed function pattern
      const isFinder = (r < 9 && c < 9) || (r < 9 && c >= size - 8) || (r >= size - 8 && c < 9);
      const isTiming = r === 6 || c === 6;
      const isAlign = alignCoords.some(ar => alignCoords.some(ac => Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2 && !((ar < 9 && ac < 9) || (ar < 9 && ac >= size - 8) || (ar >= size - 8 && ac < 9))));
      const isDark = r === size - 8 && c === 8;
      if (!isFinder && !isTiming && !isAlign && !isDark) {
        if ((r + c) % 2 === 0) {
          matrix[r][c] ^= 1;
        }
      }
    }
  }

  // 8. Place format info
  // Top-left
  matrix[8][0] = formatBits[0];
  matrix[8][1] = formatBits[1];
  matrix[8][2] = formatBits[2];
  matrix[8][3] = formatBits[3];
  matrix[8][4] = formatBits[4];
  matrix[8][5] = formatBits[5];
  matrix[8][7] = formatBits[6];
  matrix[8][8] = formatBits[7];
  matrix[7][8] = formatBits[8];
  matrix[5][8] = formatBits[9];
  matrix[4][8] = formatBits[10];
  matrix[3][8] = formatBits[11];
  matrix[2][8] = formatBits[12];
  matrix[1][8] = formatBits[13];
  matrix[0][8] = formatBits[14];

  // Bottom-left & Top-right
  for (let i = 0; i < 7; i++) matrix[size - 1 - i][8] = formatBits[i];
  for (let i = 0; i < 8; i++) matrix[8][size - 8 + i] = formatBits[7 + i];

  return matrix;
}

export function qrToSvg(matrix, { margin = 4, size = 300 } = {}) {
  const modCount = matrix.length;
  const total = modCount + margin * 2;
  let path = '';
  for (let r = 0; r < modCount; r++) {
    for (let c = 0; c < modCount; c++) {
      if (matrix[r][c] === 1) {
        path += `M${c + margin},${r + margin}h1v1h-1z `;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

export function renderQrToCanvas(canvas, matrix, { margin = 4, size = 320 } = {}) {
  const modCount = matrix.length;
  const total = modCount + margin * 2;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  const modSize = size / total;
  for (let r = 0; r < modCount; r++) {
    for (let c = 0; c < modCount; c++) {
      if (matrix[r][c] === 1) {
        ctx.fillRect(
          Math.floor((c + margin) * modSize),
          Math.floor((r + margin) * modSize),
          Math.ceil(modSize),
          Math.ceil(modSize)
        );
      }
    }
  }
}

export function generateQrPngBlob(text, options = {}) {
  const version = chooseVersion(new TextEncoder().encode(text).length);
  const matrix = createQrMatrix(text, version);
  const canvas = document.createElement('canvas');
  renderQrToCanvas(canvas, matrix, options);
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
