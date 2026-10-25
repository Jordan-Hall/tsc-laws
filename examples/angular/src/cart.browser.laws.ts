import { runModelAsync } from 'tslaws';
import type { int } from 'tslaws';
import { click, settle, type } from 'tslaws/browser';
import { AppComponent } from './app.component';
import { mountAngular } from './test/mountAngular';

type Id = 'tea' | 'mug' | 'pen';
type Op =
  | { kind: 'add'; id: Id }
  | { kind: 'remove'; id: Id }
  | { kind: 'set'; id: Id; qty: 1 | 2 | 7 | 99 }
  | { kind: 'clear' };

// The model is independent of src/: prices are written out again here, and the totals follow the shop's rules.
const price: Record<Id, number> = { tea: 499, mug: 1250, pen: 3995 };
const money = (cents: number) => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const totals = (model: Map<Id, number>) => {
  let sub = 0;
  for (const [id, qty] of model) sub += price[id] * qty;
  const discount = Math.floor((sub * (sub >= 10000 ? 1000 : sub >= 5000 ? 500 : 0)) / 10000);
  const tax = Math.floor(((sub - discount) * 2000 + 5000) / 10000);
  return { sub, discount, tax, total: sub - discount + tax };
};

export async law cartUiAgreesWithModel(ops: Op[]) {
  const app = await mountAngular(AppComponent);
  const root = app.container;
  const text = (selector: string) => root.querySelector(selector)?.textContent?.trim();
  const row = (id: Id) => root.querySelector<HTMLElement>(`.cart-row[data-id="${id}"]`);
  return runModelAsync({
    ops,
    real: root,
    model: new Map<Id, number>(),
    apply: async (_ui, model, op) => {
      const next = new Map(model);
      if (op.kind === 'add') {
        const button = root.querySelector<HTMLButtonElement>(`.product[data-id="${op.id}"] [data-add]`);
        if (button?.disabled === false) {
          click(button);
          next.set(op.id, Math.min(99, (model.get(op.id) ?? 0) + 1));
        }
      } else if (op.kind === 'remove') {
        const button = row(op.id)?.querySelector<HTMLButtonElement>('[data-remove]');
        if (button !== undefined && button !== null) {
          click(button);
          next.delete(op.id);
        }
      } else if (op.kind === 'set') {
        const field = row(op.id)?.querySelector<HTMLInputElement>('[data-qty]');
        if (field !== undefined && field !== null) {
          type(field, String(op.qty));
          next.set(op.id, op.qty);
        }
      } else {
        const button = root.querySelector<HTMLButtonElement>('[data-clear]');
        if (button !== null) click(button);
        next.clear();
      }
      await app.flush();
      return next;
    },
    agree: (ui, model) => {
      const rows = [...ui.querySelectorAll<HTMLElement>('.cart-row')];
      if (rows.length !== model.size) return false;
      for (const r of rows) {
        const id = r.dataset.id as Id;
        const field = r.querySelector<HTMLInputElement>('[data-qty]');
        if (field?.valueAsNumber !== model.get(id)) return false;
        if (r.querySelector('[data-line]')?.textContent?.trim() !== money(price[id] * (model.get(id) ?? 0))) return false;
      }
      const t = totals(model);
      return (
        text('[data-subtotal]') === money(t.sub) &&
        text('[data-discount]') === money(t.discount) &&
        text('[data-tax]') === money(t.tax) &&
        text('[data-total]') === money(t.total) &&
        (model.size === 0) === (root.querySelector('[data-empty]') !== null)
      );
    },
  });
}
