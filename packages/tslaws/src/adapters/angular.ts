/// <reference lib="dom" />
import type { Adapter } from '../component.ts';

/** The part of Angular's `ApplicationRef` the adapter uses. */
export interface AngularAppRefLike {
  injector: unknown;
  // oxlint-disable-next-line typescript/no-explicit-any
  attachView(view: any): void;
  tick(): void;
  whenStable?(): Promise<unknown>;
  destroy(): void;
}

/** The part of Angular's `ComponentRef` the adapter uses. */
export interface AngularComponentRefLike {
  setInput(name: string, value: unknown): void;
  hostView: unknown;
}

/**
 * The functions to pass, all from Angular itself:
 *
 * ```ts
 * import { createComponent, provideZonelessChangeDetection } from '@angular/core';
 * import { createApplication } from '@angular/platform-browser';
 * angularAdapter({ createApplication, createComponent, provideZonelessChangeDetection });
 * ```
 *
 * Without `provideZonelessChangeDetection` the application needs zone.js (import it in the law's module).
 */
export interface AngularFunctions {
  /** `createApplication` from `@angular/platform-browser`. */
  // oxlint-disable-next-line typescript/no-explicit-any
  createApplication(options?: any): Promise<AngularAppRefLike>;
  /** `createComponent` from `@angular/core`. */
  // oxlint-disable-next-line typescript/no-explicit-any
  createComponent(component: any, options: any): AngularComponentRefLike;
  /** `provideZonelessChangeDetection` from `@angular/core`; when given it is added to the application's providers. */
  provideZonelessChangeDetection?(): unknown;
  /** Replaces `ref.setInput(name, value)`, for example to also assign outputs. */
  setInput?(ref: AngularComponentRefLike, name: string, value: unknown): void;
  /** Extra providers for the application. */
  providers?: unknown[];
}

/**
 * Renders a standalone Angular component. Props are set with `ref.setInput`; a rerender sets them again and runs change
 * detection; unmount destroys the application.
 */
// oxlint-disable-next-line typescript/no-explicit-any
export function angularAdapter<P extends object = any>(angular: AngularFunctions): Adapter<unknown, P> {
  return {
    async render(container, component, props) {
      const providers = [...(angular.providers ?? [])];
      if (angular.provideZonelessChangeDetection !== undefined)
        providers.push(angular.provideZonelessChangeDetection());
      const app = await angular.createApplication({ providers });
      const host = document.createElement('div');
      container.appendChild(host);
      const ref = angular.createComponent(component, { environmentInjector: app.injector, hostElement: host });
      const set = (next: P): void => {
        for (const [name, value] of Object.entries(next)) {
          if (angular.setInput !== undefined) angular.setInput(ref, name, value);
          else ref.setInput(name, value);
        }
      };
      const detect = async (): Promise<void> => {
        app.tick();
        await app.whenStable?.();
      };
      set(props);
      app.attachView(ref.hostView);
      await detect();
      return {
        update: async (next) => {
          set(next);
          await detect();
        },
        unmount: () => app.destroy(),
      };
    },
  };
}
