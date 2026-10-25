import { Component, inject } from '@angular/core';
import { CartService } from './cart.service';
import { formatCents } from './pricing';
import { PRODUCTS, type Product } from './products';

@Component({
  selector: 'app-product-list',
  standalone: true,
  template: `
    <section aria-labelledby="products-heading">
      <h2 id="products-heading">Products</h2>
      <ul>
        @for (product of products; track product.id) {
          <li class="product" [attr.data-id]="product.id">
            <span>{{ product.name }} ({{ price(product) }})</span>
            <button type="button" data-add (click)="cart.add(product)" [disabled]="cart.isFull(product.id)">
              Add {{ product.name }}
            </button>
          </li>
        }
      </ul>
    </section>
  `,
})
export class ProductListComponent {
  protected readonly cart = inject(CartService);
  protected readonly products = PRODUCTS;

  price(product: Product): string {
    return formatCents(product.unitCents);
  }
}
