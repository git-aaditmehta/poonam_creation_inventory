/**
 * Optional remarks on a stock movement (agreed 2026-11-27): at most 50 words and 500 characters.
 * Same rule on the server: backend/src/utils/remarks.ts (a test checks both agree).
 */
export const REMARKS_MAX_WORDS = 50;
export const REMARKS_MAX_CHARS = 500;

export function countWords(text: string): number {
  const t = String(text ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/** null = no remarks; a string = the cleaned remarks; { error } = refused with a plain message. */
export function cleanRemarks(raw: unknown): string | null | { error: string } {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return { error: 'Remarks must be text.' };
  // Line breaks and tabs become spaces; other invisible control characters are removed
  const text = raw.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').replace(/ {2,}/g, ' ').trim();
  if (!text) return null;
  if (countWords(text) > REMARKS_MAX_WORDS) return { error: `Remarks can have at most ${REMARKS_MAX_WORDS} words.` };
  if (text.length > REMARKS_MAX_CHARS) return { error: `Remarks can have at most ${REMARKS_MAX_CHARS} characters.` };
  return text;
}
