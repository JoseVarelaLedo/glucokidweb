import { Injectable, effect, signal } from '@angular/core';

export type LayoutMode = 'mobile' | 'desktop';
const KEY = 'glucokid:layout';

/** Vista móvil por defecto, con interruptor a vista de ordenador. */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  readonly mode = signal<LayoutMode>(this.load());

  constructor() {
    effect(() => {
      const m = this.mode();
      document.documentElement.dataset['layout'] = m;
      try {
        localStorage.setItem(KEY, m);
      } catch {
        /* sin almacenamiento: no pasa nada */
      }
    });
  }

  toggle(): void {
    this.mode.update((m) => (m === 'mobile' ? 'desktop' : 'mobile'));
  }

  private load(): LayoutMode {
    try {
      return localStorage.getItem(KEY) === 'desktop' ? 'desktop' : 'mobile';
    } catch {
      return 'mobile';
    }
  }
}
