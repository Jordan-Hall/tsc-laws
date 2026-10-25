import { Injectable, computed, signal } from '@angular/core';
import type { int } from 'tslaws';
import { MAX_QUANTITY, clampQuantity, orderSummary, type LineItem } from './pricing';
import { TAX_RATE_BPS, type Product } from './products';

@Injectable({ providedIn: 'root' })
export class CartService {
  readonly items = signal<LineItem[]>([]);
  readonly count = computed(() => this.items().reduce((n, item) => n + item.quantity, 0));
  readonly summary = computed(() => orderSummary(this.items(), TAX_RATE_BPS));

  add(product: Product): void {
    this.items.update((items) => {
      const at = items.findIndex((item) => item.id === product.id);
      if (at < 0) return [...items, { ...product, quantity: 1 as int }];
      return items.map((item, i) => (i === at ? { ...item, quantity: clampQuantity(item.quantity + 1) } : item));
    });
  }

  remove(id: string): void {
    this.items.update((items) => items.filter((item) => item.id !== id));
  }

  /** Sets a quantity clamped to the allowed range; an id that is not in the cart is ignored. */
  setQuantity(id: string, quantity: number): void {
    const next = clampQuantity(quantity);
    this.items.update((items) => items.map((item) => (item.id === id ? { ...item, quantity: next } : item)));
  }

  clear(): void {
    this.items.set([]);
  }

  isFull(id: string): boolean {
    return this.items().some((item) => item.id === id && item.quantity >= MAX_QUANTITY);
  }
}
