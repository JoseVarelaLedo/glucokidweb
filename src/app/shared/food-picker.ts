import { Component, ElementRef, OnDestroy, computed, effect, input, model, signal, viewChild } from '@angular/core';
import { FOOD_GROUPS } from '../core/defaults';
import { Food } from '../core/models';
import { fmtNum } from '../core/util';

let nextId = 0;
const MAX_ROWS = 80;

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

type Row = { key: string; kind: 'group'; label: string } | { key: string; kind: 'food'; food: Food; idx: number };

/**
 * Selector de alimentos con búsqueda (tipo "chosen"): se escribe para filtrar y se elige de la lista.
 *  - Modo texto (registro): `value` es el NOMBRE; también admite alimentos que no estén en el catálogo.
 *  - Modo estricto (calculadora): `value` es el ID de un alimento del catálogo.
 * La lista se coloca con `position: fixed` para no quedar recortada por las tarjetas con `overflow: hidden`.
 */
@Component({
  selector: 'app-food-picker',
  template: `
    <input
      #box
      type="text"
      role="combobox"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      aria-autocomplete="list"
      [attr.id]="inputId() || null"
      [attr.aria-label]="inputId() ? null : ariaLabel()"
      [attr.aria-expanded]="isOpen()"
      [attr.aria-controls]="uid + '-list'"
      [attr.aria-activedescendant]="isOpen() && active() >= 0 ? uid + '-o' + active() : null"
      [placeholder]="placeholder()"
      [value]="text()"
      (focus)="openList()"
      (click)="openList()"
      (input)="onInput($any($event.target).value)"
      (keydown)="onKey($event)"
      (blur)="onBlur()"
    />
    @if (isOpen() && pos(); as p) {
      <ul
        class="fp-list"
        role="listbox"
        [attr.id]="uid + '-list'"
        [style.left.px]="p.left"
        [style.width.px]="p.width"
        [style.top.px]="p.top"
        [style.bottom.px]="p.bottom"
        [style.max-height.px]="p.maxH"
      >
        @for (r of rows(); track r.key) {
          @if (r.kind === 'group') {
            <li class="fp-group" role="presentation">{{ r.label }}</li>
          } @else {
            <li
              role="option"
              class="fp-opt"
              [attr.id]="uid + '-o' + r.idx"
              [class.active]="r.idx === active()"
              [class.selected]="isSelected(r.food)"
              [attr.aria-selected]="isSelected(r.food)"
              (pointerdown)="pick(r.food, $event)"
              (mousemove)="active.set(r.idx)"
            >
              <span class="fp-name">{{ r.food.name }}</span>
              <small>{{ hint(r.food) }}</small>
            </li>
          }
        }
        @if (!count()) {
          <li class="fp-empty" role="presentation">
            {{ strict() ? 'Ningún alimento coincide.' : 'Sin coincidencias: se guardará con el nombre que escribas.' }}
          </li>
        } @else if (more() > 0) {
          <li class="fp-empty" role="presentation">y {{ more() }} más: sigue escribiendo para acotar.</li>
        }
      </ul>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        min-width: 0;
      }
      .fp-list {
        position: fixed;
        z-index: 80;
        margin: 0;
        padding: 4px;
        list-style: none;
        overflow-y: auto;
        overscroll-behavior: contain;
        background: var(--surface);
        border: 1.5px solid var(--accent);
        border-radius: 12px;
        box-shadow: 0 10px 30px rgb(0 0 0 / 22%);
      }
      .fp-group {
        padding: 8px 10px 2px;
        font-size: 0.72rem;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
      }
      .fp-opt {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        min-height: 44px;
        padding: 6px 10px;
        border-radius: 8px;
        cursor: pointer;
        color: var(--text);
      }
      .fp-opt.active {
        background: var(--accent-soft);
      }
      .fp-opt.selected .fp-name {
        font-weight: 800;
        color: var(--accent);
      }
      .fp-opt small {
        flex: none;
        color: var(--muted);
        white-space: nowrap;
      }
      .fp-empty {
        padding: 10px;
        font-size: 0.9rem;
        color: var(--muted);
      }
    `,
  ],
})
export class FoodPicker implements OnDestroy {
  readonly foods = input.required<Food[]>();
  readonly gramsPerRation = input(10);
  /** true: `value` es el id de un alimento del catálogo; false: es el nombre (texto libre admitido). */
  readonly strict = input(false);
  readonly inputId = input('');
  readonly ariaLabel = input('Alimento');
  readonly placeholder = input('Alimento');
  readonly value = model<string>('');

  protected readonly uid = `fp${nextId++}`;
  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');

  protected readonly text = signal('');
  private readonly filter = signal('');
  protected readonly isOpen = signal(false);
  protected readonly active = signal(-1);
  protected readonly pos = signal<{ left: number; width: number; top: number | null; bottom: number | null; maxH: number } | null>(null);

  private readonly groupOrder = (g: string) => {
    const i = (FOOD_GROUPS as readonly string[]).indexOf(g);
    return i < 0 ? 99 : i;
  };

  /** Alimentos que cumplen el filtro, ordenados (los que empiezan por lo escrito, primero). */
  private readonly matches = computed<Food[]>(() => {
    const q = norm(this.filter());
    const all = this.foods();
    if (!q) {
      return [...all].sort(
        (a, b) => this.groupOrder(a.group) - this.groupOrder(b.group) || a.name.localeCompare(b.name, 'es'),
      );
    }
    const hits = all.filter((f) => norm(f.name).includes(q));
    return hits.sort((a, b) => {
      const sa = norm(a.name).startsWith(q) ? 0 : 1;
      const sb = norm(b.name).startsWith(q) ? 0 : 1;
      return sa - sb || a.name.localeCompare(b.name, 'es');
    });
  });

  protected readonly count = computed(() => Math.min(this.matches().length, MAX_ROWS));
  protected readonly more = computed(() => Math.max(0, this.matches().length - MAX_ROWS));

  /** Filas de la lista: con el filtro vacío se agrupan por grupo de alimentos. */
  protected readonly rows = computed<Row[]>(() => {
    const list = this.matches().slice(0, MAX_ROWS);
    const grouped = !this.filter().trim();
    const out: Row[] = [];
    let last = '';
    list.forEach((food, idx) => {
      if (grouped && food.group !== last) {
        last = food.group;
        out.push({ key: 'g:' + food.group, kind: 'group', label: food.group });
      }
      out.push({ key: food.id, kind: 'food', food, idx });
    });
    return out;
  });

  private listener = (): void => this.place();

  constructor() {
    // El texto que se ve sigue al valor (y al catálogo, por si carga después)
    effect(() => {
      const v = this.value();
      const foods = this.foods();
      const next = this.strict() ? (foods.find((f) => f.id === v)?.name ?? '') : v;
      if (next !== this.text()) this.text.set(next);
    });
  }

  ngOnDestroy(): void {
    this.detach();
  }

  protected hint(f: Food): string {
    return f.carbsPer100g > 0 ? `1 ración = ${fmtNum((this.gramsPerRation() * 100) / f.carbsPer100g, 0)} g` : 'sin hidratos';
  }

  protected isSelected(f: Food): boolean {
    return this.strict() ? this.value() === f.id : norm(this.value()) === norm(f.name);
  }

  /* ------------------------- apertura y posición ------------------------- */

  protected openList(): void {
    if (this.isOpen()) return;
    // En modo estricto, con un alimento ya elegido se enseña la lista completa; en modo texto, lo que coincide con lo escrito.
    this.filter.set(this.strict() ? '' : this.text());
    this.isOpen.set(true);
    this.active.set(this.firstActive());
    this.place();
    window.addEventListener('scroll', this.listener, true);
    window.addEventListener('resize', this.listener);
    window.visualViewport?.addEventListener('resize', this.listener);
  }

  private closeList(): void {
    this.isOpen.set(false);
    this.detach();
  }

  private detach(): void {
    window.removeEventListener('scroll', this.listener, true);
    window.removeEventListener('resize', this.listener);
    window.visualViewport?.removeEventListener('resize', this.listener);
  }

  private firstActive(): number {
    const sel = this.matches().slice(0, MAX_ROWS).findIndex((f) => this.isSelected(f));
    return sel >= 0 ? sel : this.matches().length ? 0 : -1;
  }

  /** Coloca la lista junto al campo: debajo si cabe y, si no, encima. */
  private place(): void {
    if (!this.isOpen()) return;
    const r = this.box().nativeElement.getBoundingClientRect();
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const below = vh - r.bottom - 12;
    const above = r.top - 12;
    const wanted = 300;
    // La lista puede ser más ancha que el campo (nombre + equivalencia), sin salirse de la pantalla
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const width = Math.min(Math.max(r.width, 280), vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    if (below >= Math.min(wanted, 200) || below >= above) {
      this.pos.set({ left, width, top: r.bottom + 4, bottom: null, maxH: Math.max(120, Math.min(wanted, below)) });
    } else {
      this.pos.set({ left, width, top: null, bottom: window.innerHeight - r.top + 4, maxH: Math.max(120, Math.min(wanted, above)) });
    }
    const el = this.box().nativeElement;
    if (r.bottom < 0 || r.top > vh) el.blur(); // el campo salió de la pantalla al hacer scroll
  }

  /* ------------------------- eventos ------------------------- */

  protected onInput(v: string): void {
    this.text.set(v);
    this.filter.set(v);
    if (!this.strict()) this.value.set(v);
    if (!this.isOpen()) this.openList();
    this.active.set(this.matches().length ? 0 : -1);
    this.place();
  }

  protected onKey(e: KeyboardEvent): void {
    const n = this.count();
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!this.isOpen()) {
          this.openList();
          return;
        }
        if (!n) return;
        const d = e.key === 'ArrowDown' ? 1 : -1;
        this.active.set((this.active() + d + n) % n);
        queueMicrotask(() =>
          document.getElementById(`${this.uid}-o${this.active()}`)?.scrollIntoView({ block: 'nearest' }),
        );
        return;
      }
      case 'Enter': {
        const f = this.matches()[this.active()];
        if (this.isOpen() && f) {
          e.preventDefault();
          this.choose(f);
        }
        return;
      }
      case 'Escape':
        if (this.isOpen()) {
          e.preventDefault();
          this.closeList();
        }
        return;
      case 'Tab':
        this.closeList();
        return;
    }
  }

  protected onBlur(): void {
    this.closeList();
    if (this.strict()) {
      // en modo estricto el campo solo puede mostrar un alimento del catálogo (o estar vacío)
      if (!this.text().trim()) this.value.set('');
      else this.text.set(this.foods().find((f) => f.id === this.value())?.name ?? '');
    }
  }

  protected pick(f: Food, ev: Event): void {
    ev.preventDefault(); // mantiene el foco: así no se cierra la lista antes de elegir
    this.choose(f);
    this.box().nativeElement.blur();
  }

  private choose(f: Food): void {
    this.text.set(f.name);
    this.value.set(this.strict() ? f.id : f.name);
    this.closeList();
  }
}
