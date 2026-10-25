import { Component, inject } from '@angular/core';
import { CartService } from './cart.service';
import { CartComponent } from './cart.component';
import { ProductListComponent } from './product-list.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ProductListComponent, CartComponent],
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
