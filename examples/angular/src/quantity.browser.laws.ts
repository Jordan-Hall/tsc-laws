import { assume } from 'tslaws';
import type { int } from 'tslaws';
import { click, type } from 'tslaws/browser';
import { AppComponent } from './app.component';
import { CartService as CartServiceToken } from './cart.service';
import { mountAngular } from './test/mountAngular';

const cents = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

// Mug: 12.50 each. Subtotal is checked against price * clamped quantity written out here, independent of src/.
export async law typedQuantityScalesSubtotal(qty: int) {
  assume(qty >= -20 && qty <= 150);
  const app = await mountAngular(AppComponent);
  click(app.container.querySelector<HTMLButtonElement>('.product[data-id="mug"] [data-add]')!);
  await app.flush();
  const field = app.container.querySelector<HTMLInputElement>('.cart-row [data-qty]')!;
  type(field, String(qty));
  await app.flush();
  const clamped = Math.min(99, Math.max(1, qty));
  return (
    app.container.querySelector('[data-subtotal]')?.textContent?.trim() === cents(1250 * clamped) &&
    field.valueAsNumber === clamped &&
    app.get(CartServiceToken).count() === clamped
  );
}

export async law junkQuantityFallsBackToOne(text: 'abc' | '' | '-' | '1e999' | '0') {
  const app = await mountAngular(AppComponent);
  click(app.container.querySelector<HTMLButtonElement>('.product[data-id="tea"] [data-add]')!);
  await app.flush();
  const field = app.container.querySelector<HTMLInputElement>('.cart-row [data-qty]')!;
  type(field, text);
  await app.flush();
  // A number field reports every one of these as invalid or below the minimum, so the quantity stays at 1.
  return field.valueAsNumber === 1 && app.get(CartServiceToken).count() === 1;
}

export async law quantityStopsAtNinetyNine(over: 0 | 1 | 5 | 1000) {
  const app = await mountAngular(AppComponent);
  click(app.container.querySelector<HTMLButtonElement>('.product[data-id="pen"] [data-add]')!);
  await app.flush();
  const field = app.container.querySelector<HTMLInputElement>('.cart-row [data-qty]')!;
  type(field, String(99 + over));
  await app.flush();
  return (
    field.valueAsNumber === 99 &&
    app.get(CartServiceToken).count() === 99 &&
    app.container.querySelector<HTMLButtonElement>('.product[data-id="pen"] [data-add]')!.disabled
  );
}
