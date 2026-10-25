// Mounts a standalone component into a tslaws `mount()` container, running Angular's JIT compiler with zoneless change
// detection (no zone.js). Used only by browser laws; it is covered because those laws call it.
import '@angular/compiler';
import {
  createComponent,
  provideZonelessChangeDetection,
  type ApplicationRef,
  type ComponentRef,
  type Type,
} from '@angular/core';
import { createApplication } from '@angular/platform-browser';
import { mount, settle } from 'tslaws/browser';

export interface Mounted<T> {
  /** The container returned by tslaws `mount()`; the component's host element is inside it. */
  container: HTMLElement;
  app: ApplicationRef;
  /** The component, for `setInput` and `location`. */
  ref: ComponentRef<T>;
  instance: T;
  /** Resolves a service from the app's root injector, so a law can look at the state behind the DOM. */
  get<S>(token: Type<S>): S;
  /** Runs change detection and waits for the DOM to catch up. */
  flush(): Promise<void>;
}

export async function mountAngular<T>(component: Type<T>, inputs: Record<string, unknown> = {}): Promise<Mounted<T>> {
  let app: ApplicationRef | undefined;
  // mount() runs the destroy function after the law, so the application never outlives its input.
  const container = mount(() => () => app?.destroy());
  app = await createApplication({ providers: [provideZonelessChangeDetection()] });
  const host = document.createElement('div');
  container.appendChild(host);
  const ref = createComponent(component, { environmentInjector: app.injector, hostElement: host });
  for (const [name, value] of Object.entries(inputs)) ref.setInput(name, value);
  app.attachView(ref.hostView);
  const flush = async (): Promise<void> => {
    app.tick();
    await app.whenStable();
    await settle(0);
  };
  await flush();
  return { container, app, ref, instance: ref.instance, get: (token) => app.injector.get(token), flush };
}
