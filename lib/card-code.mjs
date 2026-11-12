import { randomInt } from 'node:crypto';

// Crockford Base32 alphabet (32 characters, excluding 0, O, 1, I)
export const CARD_CODE_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CARD_CODE_LENGTH = 8;
export const CARD_CODE_REGEX = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;

/**
 * Generate a single cryptographically secure 8-character card code.
 */
export function generateCardCode() {
  const chars = [];
  const alphabetLen = CARD_CODE_CHARSET.length;
  for (let i = 0; i < CARD_CODE_LENGTH; i++) {
    const idx = randomInt(0, alphabetLen);
    chars.push(CARD_CODE_CHARSET[idx]);
  }
  return chars.join('');
}

/**
 * Generate a batch of N unique card codes.
 * Ensures within-batch uniqueness.
 */
export function generateUniqueCardCodes(count) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Count must be a positive integer');
  }
  const codes = new Set();
  while (codes.size < count) {
    codes.add(generateCardCode());
  }
  return Array.from(codes);
}

/**
 * Check if a card code matches the 8-character format.
 */
export function isValidCardCode(code) {
  return typeof code === 'string' && CARD_CODE_REGEX.test(code);
}
