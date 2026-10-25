import { Component, inject } from '@angular/core';
import { CartService } from './cart.service';
import { formatCents, lineTotal } from './pricing';
import type { int } from 'tslaws';
import { QuantityInputComponent } from './quantity-input.component';

@Component({
  selector: 'app-cart',
  standalone: true,
  imports: [QuantityInputComponent],
  template: `
    <section aria-labelledby="cart-heading">
      <h2 id="cart-heading">Cart</h2>
      @if (cart.items().length === 0) {
        <p data-empty>Your cart is empty.</p>
      } @else {
        <ul>
          @for (item of cart.items(); track item.id) {
            <li class="cart-row" [attr.data-id]="item.id">
              <span class="name">{{ item.name }}</span>
              <app-quantity-input
                [quantity]="item.quantity"
                [label]="item.name"
                (quantityChange)="cart.setQuantity(item.id, $event)"
              />
              <span class="line" data-line>{{ money(lineTotal(item.unitCents, item.quantity)) }}</span>
              <button type="button" data-remove (click)="cart.remove(item.id)">Remove {{ item.name }}</button>
            </li>
          }
        </ul>
        <button type="button" data-clear (click)="cart.clear()">Clear cart</button>
      }
      <dl>
        <dt>Subtotal</dt>
        <dd data-subtotal>{{ money(cart.summary().subtotal) }}</dd>
        <dt>Discount</dt>
        <dd data-discount>{{ money(cart.summary().discount) }}</dd>
        <dt>Tax</dt>
        <dd data-tax>{{ money(cart.summary().tax) }}</dd>
        <dt>Total</dt>
        <dd data-total>{{ money(cart.summary().total) }}</dd>
      </dl>
    </section>
  `,
})
export class CartComponent {
  protected readonly cart = inject(CartService);
  protected readonly lineTotal = lineTotal;

  money(cents: int): string {
    return formatCents(cents);
  }
}
