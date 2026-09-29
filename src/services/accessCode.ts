/**
 * Генерация кода доступа для регистрации квартиры.
 *
 * Алфавит намеренно без символов, которые легко перепутать при
 * печати на листке и вводе с телефона: без 0/O, 1/I/L.
 * 32 символа делят 256 без остатка, поэтому смещения (bias) от
 * остатка от деления на 256 не возникает.
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function generateAccessCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);

  let code = "";
  for (const byte of bytes) {
    code += ALPHABET[byte % ALPHABET.length];
  }
  return code;
}