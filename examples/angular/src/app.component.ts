import { Component, inject, ViewEncapsulation } from '@angular/core';
import { CartService } from './cart.service';
import { CartComponent } from './cart.component';
import { ProductListComponent } from './product-list.component';

// The look of the shop. The styles are not encapsulated, so they reach the product list, the cart and the quantity fields inside.
const look = `
app-root main { --ink: #1f2937; --muted: #4b5563; --line: #e5e7eb; --accent: #0369a1; --accent-soft: #e0f2fe; --danger: #b91c1c;
  display: block; box-sizing: border-box; max-width: 40rem; margin: 2rem auto; padding: 0 0 1.25rem; background: #fff; color: var(--ink);
  border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 10px 30px rgba(31, 41, 55, .10); overflow: hidden;
  font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
app-root h1 { margin: 0; padding: 1.25rem 1.5rem; font-size: 1.35rem; color: #fff; background: linear-gradient(135deg, #0369a1, #0f766e); }
app-root section { padding: 1rem 1.5rem 0; }
app-root h2 { margin: 0 0 .5rem; font-size: 1.05rem; }
app-root ul { list-style: none; margin: 0; padding: 0; display: grid; gap: .4rem; }
app-root li { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .5rem .75rem; border: 1px solid var(--line); border-radius: 12px; }
app-root li.cart-row .name { flex: 1; font-weight: 600; }
app-root button { font: inherit; cursor: pointer; padding: .4rem .8rem; border-radius: 10px; border: 1px solid transparent; background: var(--accent); color: #fff; }
app-root button:hover:not(:disabled) { filter: brightness(1.12); }
app-root button:disabled { cursor: not-allowed; opacity: .5; }
app-root button[data-remove], app-root button[data-clear] { background: transparent; color: var(--danger); border-color: var(--line); }
app-root input[data-qty] { width: 4.5rem; font: inherit; padding: .35rem .5rem; border: 1px solid #9ca3af; border-radius: 8px; }
app-root button:focus-visible, app-root input:focus-visible { outline: 3px solid #7dd3fc; outline-offset: 2px; }
app-root [data-empty] { margin: 0; color: var(--muted); }
app-root dl { display: grid; grid-template-columns: 1fr auto; gap: .25rem 1rem; margin: 1rem 0 0; padding: .75rem 1rem; background: var(--accent-soft); border-radius: 12px; }
app-root dt { color: #075985; }
app-root dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
app-root dt:last-of-type, app-root dd:last-of-type { font-weight: 700; font-size: 1.1rem; }
`;

@Component({
  selector: 'app-root',
  standalone: true,
  encapsulation: ViewEncapsulation.None,
  imports: [ProductListComponent, CartComponent],
  styles: [look],
  template: `
    <main>
      <h1>Shop ({{ cart.count() }} items)</h1>
      <app-product-list />
      <app-cart />
    </main>
  `,
})
export class AppComponent {
  protected readonly cart = inject(CartService);
}
