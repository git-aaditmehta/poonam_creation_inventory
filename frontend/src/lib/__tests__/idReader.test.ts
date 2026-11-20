/**
 * "Read ID from photo": the format rule (what may be filled in) and the text-strip finder.
 * The OCR engine itself is tested in the browser (test O: 79/79 on the sample photos).
 */
import { describe, it, expect } from 'vitest';
import { parseItemId } from '../ocr/idReader';
import { findTextLine } from '../dino/catalogCropCore';

describe('ID format rule (a wrong ID is worse than an empty field)', () => {
  it('reads plain IDs', () => {
    expect(parseItemId('PS 367')).toBe('PS 367');
    expect(parseItemId('ER 120\n')).toBe('ER 120');
    expect(parseItemId('JK43')).toBe('JK 43');
  });
  it('takes the first ID when there is more text', () => {
    expect(parseItemId('PS 376(PCJ 8)')).toBe('PS 376');
  });
  it('fixes letters OCR confuses with digits, only in the number', () => {
    expect(parseItemId('PS 3G7')).toBe('PS 367');
    expect(parseItemId('BR 1O9')).toBe('BR 109');
    expect(parseItemId('ER 1I1')).toBe('ER 111');
  });
  it('leaves the field empty for anything that is not a known ID', () => {
    expect(parseItemId('')).toBeNull();
    expect(parseItemId('HELLO WORLD')).toBeNull();
    expect(parseItemId('XY 123')).toBeNull(); // unknown prefix
    expect(parseItemId('ERX 12')).toBeNull(); // ERX is not ER
    expect(parseItemId('PS')).toBeNull(); // no number
    expect(parseItemId('PS 12345')).toBeNull(); // too long
  });
  it('uses the given category prefixes (a new category is read too)', () => {
    expect(parseItemId('NK 12', ['ER', 'NK'])).toBe('NK 12');
    expect(parseItemId('NK 12')).toBeNull();
  });
});

describe('text strip for the reader', () => {
  const photo = (withText: boolean) => {
    const W = 300, H = 240;
    const px = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) px.set([200, 200, 205, 255], i * 4);
    for (let y = 120; y < 200; y++) for (let x = 100; x < 200; x++) px.set([200, 182, 100, 255], (y * W + x) * 4); // gold
    for (let y = 150; y < 170; y++) for (let x = 140; x < 160; x++) px.set([220, 30, 40, 255], (y * W + x) * 4); // ruby in gold
    if (withText) for (let y = 20; y < 50; y++) for (let x = 40; x < 140; x++) if ((x >> 3) % 2 === 0) px.set([235, 40, 45, 255], (y * W + x) * 4);
    return { px, W, H };
  };
  it('finds the red text line (not the ruby) and makes it black on white', () => {
    const { px, W, H } = photo(true);
    const s = findTextLine(px, W, H)!;
    expect(s).not.toBeNull();
    expect(s.box.y0).toBeLessThan(25);
    expect(s.box.y1).toBeLessThan(60); // the ruby (rows 150-170) is not part of it
    expect(s.gray.some((v) => v === 0)).toBe(true);
    expect(s.gray[0]).toBe(255); // white margin
  });
  it('no red text -> null (field left empty with a message)', () => {
    const { px, W, H } = photo(false);
    expect(findTextLine(px, W, H)).toBeNull();
  });
});
