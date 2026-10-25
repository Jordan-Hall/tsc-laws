import { assume } from 'tslaws';
import type { int } from 'tslaws';
import { click, type } from 'tslaws/browser';
import { CartComponent } from './cart.component';
import { CartService } from './cart.service';
import { ProductListComponent } from './product-list.component';
import { QuantityInputComponent } from './quantity-input.component';
import { PRODUCTS } from './products';
import { mountAngular } from './test/mountAngular';

// The same components that app.component composes, mounted one at a time with their inputs set directly.

export async law quantityInputEmitsClampedValue(raw: int, shown: int) {
  assume(raw >= -50 && raw <= 200 && shown >= 1 && shown <= 99);
  const app = await mountAngular(QuantityInputComponent, { quantity: shown, label: 'Widget' });
  const field = app.container.querySelector<HTMLInputElement>('[data-qty]')!;
  const emitted: number[] = [];
  app.instance.quantityChange.subscribe((n) => emitted.push(n));
  const shownOk = field.valueAsNumber === shown && field.getAttribute('aria-label') === 'Quantity of Widget';
  type(field, String(raw));
  await app.flush();
  const clamped = Math.min(99, Math.max(1, raw));
  return shownOk && emitted.length === 1 && emitted[0] === clamped && field.valueAsNumber === clamped;
}

export async law productListAddsToCart(clicks: int) {
  assume(clicks >= 0 && clicks <= 5);
  const app = await mountAngular(ProductListComponent);
  const buttons = [...app.container.querySelectorAll<HTMLButtonElement>('[data-add]')];
  for (let i = 0; i < clicks; i++) click(buttons[i % buttons.length]!);
  await app.flush();
  const cart = app.get(CartService);
  return buttons.length === PRODUCTS.length && cart.count() === clicks;
}

export async law cartListsServiceItemsAndRemovesThem(picks: ('tea' | 'mug' | 'pen')[]) {
  assume(picks.length <= 6);
  const app = await mountAngular(CartComponent);
  const cart = app.get(CartService);
  for (const id of picks) cart.add(PRODUCTS.find((p) => p.id === id)!);
  await app.flush();
  const distinct = new Set(picks);
  const rows = [...app.container.querySelectorAll<HTMLElement>('.cart-row')];
  if (rows.length !== distinct.size) return false;
  for (const row of rows) click(row.querySelector<HTMLButtonElement>('[data-remove]')!);
  await app.flush();
  return (
    cart.items().length === 0 &&
    app.container.querySelector('[data-empty]') !== null &&
    app.container.querySelector('[data-total]')?.textContent?.trim() === '$0.00'
  );
}
