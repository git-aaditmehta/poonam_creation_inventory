import { describe, it, expect } from 'vitest';
import * as app from '../../utils/remarks';
import * as server from '../../../../backend/src/utils/remarks';

// Stock movement remarks (2026-11-27): the app and the server must accept and refuse exactly the same text
describe('stock remarks rule: app = server', () => {
  const fifty = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
  const cases: unknown[] = [undefined, null, '', '   ', 'Sold to Kunalji', '  From  Ravi\nkarigar\tlot 12  ', fifty, fifty + ' extra', 'x'.repeat(500), 'x'.repeat(501), 42, 'a\u0007b'];
  it.each(cases.map((c) => [c]))('same answer for %j', (c) => {
    expect(app.cleanRemarks(c)).toEqual(server.cleanRemarks(c));
  });
  it('empty means no remarks; text is tidied', () => {
    expect(app.cleanRemarks('   ')).toBeNull();
    expect(app.cleanRemarks('  From  Ravi\nkarigar\tlot 12  ')).toBe('From Ravi karigar lot 12');
  });
  it('50 words allowed, 51 refused', () => {
    expect(app.cleanRemarks(fifty)).toBe(fifty);
    expect(app.cleanRemarks(fifty + ' extra')).toEqual({ error: 'Remarks can have at most 50 words.' });
    expect(app.countWords(fifty)).toBe(50);
  });
});
