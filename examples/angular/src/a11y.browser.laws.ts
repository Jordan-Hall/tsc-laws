import { assume } from 'tslaws';
import type { int } from 'tslaws';
import { accessible } from 'tslaws/browser';
import { click } from 'tslaws/browser';
import { AppComponent } from './app.component';
import { mountAngular } from './test/mountAngular';

// Add 0..4 products (cycling through the catalogue) and audit the whole app with axe-core.
export async law shopHasNoAccessibilityViolations(adds: int) {
  assume(adds >= 0 && adds <= 4);
  const app = await mountAngular(AppComponent);
  const ids = ['tea', 'mug', 'pen'];
  for (let i = 0; i < adds; i++) {
    click(app.container.querySelector<HTMLButtonElement>(`.product[data-id="${ids[i % 3]}"] [data-add]`)!);
    await app.flush();
  }
  return await accessible(app.container);
}
