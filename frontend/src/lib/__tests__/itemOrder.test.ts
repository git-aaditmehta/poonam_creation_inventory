import { describe, it, expect } from 'vitest';
import { KUNDAN_ORDER, compareStoneNames, compareJewelryCodes, sortInventory, sortLowStock, stoneFamily } from '../../utils/itemOrder';
import { DEFAULT_JEWELRY_TYPES } from '../../utils/jewelryCategory';

const shuffle = <T,>(a: T[]) => a.map((v, i) => [Math.sin(i * 9301 + 49297) , v] as const).sort((x, y) => x[0] - y[0]).map(([, v]) => v);

describe('display order (2026-11-22)', () => {
  it('Kundan stones: exactly the client\'s list, from any starting order', () => {
    expect([...shuffle(KUNDAN_ORDER)].sort(compareStoneNames)).toEqual(KUNDAN_ORDER);
    expect(['p8(l)', ' 3/6 leaf(r) ', 'TAPER(2/3/3)'].sort(compareStoneNames)).toEqual([' 3/6 leaf(r) ', 'TAPER(2/3/3)', 'p8(l)']);
  });
  it('new stone names join their family in number order; a new family goes after the known ones', () => {
    const list = [...KUNDAN_ORDER, '7/9 DROP', '9MM ROUND', 'P16', 'A50', 'CRYSTAL 4', '4/4 LEAF(L)'].sort(compareStoneNames);
    const at = (n: string) => list.indexOf(n);
    expect(at('6/9 DROP') < at('7/9 DROP') && at('7/9 DROP') < at('10/15 DROP')).toBe(true);
    expect(at('8MM ROUND') < at('9MM ROUND') && at('9MM ROUND') < at('10MM ROUND')).toBe(true);
    expect(at('P15') < at('P16') && at('P16') < at('P21')).toBe(true);
    expect(at('A49') < at('A50') && at('A50') < at('A52')).toBe(true);
    expect(at('3/6 LEAF(L)') < at('4/4 LEAF(L)') && at('4/4 LEAF(L)') < at('4/8 LEAF(R)')).toBe(true);
    expect(list[list.length - 1]).toBe('CRYSTAL 4');
    expect(['3/6 LEAF(R)', '7MM ROUND', 'P8(L)', 'OVEL TRIANGLE(FAN)'].map(stoneFamily)).toEqual(['LEAF', 'MMROUND', 'P', 'OVELTRIANGLE']);
  });
  it('Plated / Raw: grouped by type in the types\' order, numbers small to big, Other last', () => {
    const codes = ['PS 10', 'ER 5', 'PS 2', 'JK 33', 'PS 1017(TP)', 'PS 982(TP)', 'ZZ 1', 'NK 3', 'BG 1', 'PD 262(TP)', 'er-1', 'AB 2'];
    expect([...codes].sort((a, b) => compareJewelryCodes(a, b, DEFAULT_JEWELRY_TYPES))).toEqual([
      'er-1', 'ER 5', 'PS 2', 'PS 10', 'PS 982(TP)', 'PS 1017(TP)', 'JK 33', 'PD 262(TP)', 'NK 3', 'BG 1', 'AB 2', 'ZZ 1',
    ]);
  });
  it('Foil: lightest first', () => {
    const rows = [{ item_id: 'F2', quantity: 1.5 }, { item_id: 'F1', quantity: 0.2 }, { item_id: 'F3', quantity: 10 }];
    expect(sortInventory('foil', rows).map((r) => r.item_id)).toEqual(['F1', 'F2', 'F3']);
  });
  it('Low Stock: Plated, Raw, Kundan, Foil, each in its own section order', () => {
    const rows = [
      { category: 'foil', item_id: 'F2', quantity: 2 }, { category: 'stones', item_id: 'P21', quantity: 1 },
      { category: 'raw_jewelry', item_id: 'PS 10', quantity: 0 }, { category: 'plated_jewelry', item_id: 'PS 10', quantity: 0 },
      { category: 'stones', item_id: '3/5 DROP', quantity: 1 }, { category: 'plated_jewelry', item_id: 'ER 7', quantity: 0 },
      { category: 'raw_jewelry', item_id: 'ER 2', quantity: 0 }, { category: 'foil', item_id: 'F1', quantity: 0.5 },
      { category: 'plated_jewelry', item_id: 'PS 2', quantity: 0 },
    ];
    expect(sortLowStock(rows).map((r) => `${r.category.slice(0, 3)}:${r.item_id}`)).toEqual([
      'pla:ER 7', 'pla:PS 2', 'pla:PS 10', 'raw:ER 2', 'raw:PS 10', 'sto:3/5 DROP', 'sto:P21', 'foi:F1', 'foi:F2',
    ]);
  });
});
