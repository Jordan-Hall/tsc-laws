import { Component, Input, Output, input, output } from '@angular/core';
import type { int } from 'tslaws';
import { MAX_QUANTITY, MIN_QUANTITY, clampQuantity } from './pricing';

@Component({
  selector: 'app-quantity-input',
  standalone: true,
  template: `
    <input
      type="number"
      data-qty
      [attr.aria-label]="'Quantity of ' + label()"
      [attr.min]="min"
      [attr.max]="max"
      [value]="quantity()"
      (input)="changed($event)"
    />
  `,
})
export class QuantityInputComponent {
  @Input({ isSignal: true, alias: 'quantity', required: true, transform: undefined } as never)
  readonly quantity = input.required<int>();
  @Input({ isSignal: true, alias: 'label', required: true, transform: undefined } as never)
  readonly label = input.required<string>();
  @Output('quantityChange')
  readonly quantityChange = output<int>();
  readonly min = MIN_QUANTITY;
  readonly max = MAX_QUANTITY;

  changed(event: Event): void {
    const field = event.target as HTMLInputElement;
    const next = clampQuantity(field.valueAsNumber);
    // Show the clamped value even when it equals the current quantity (the binding would not rewrite the field).
    field.value = String(next);
    this.quantityChange.emit(next);
  }
}
