import type { int } from 'tslaws';

export interface Product {
  id: string;
  name: string;
  unitCents: int;
}

export const PRODUCTS: readonly Product[] = [
  { id: 'tea', name: 'Green tea', unitCents: 499 as int },
  { id: 'mug', name: 'Enamel mug', unitCents: 1250 as int },
  { id: 'pen', name: 'Fountain pen', unitCents: 3995 as int },
];

/** Sales tax rate in basis points (2000 = 20%). */
export const TAX_RATE_BPS = 2000 as int;
