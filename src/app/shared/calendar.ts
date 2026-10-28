import { Component, computed, input, linkedSignal, output } from '@angular/core';
import { DayMark } from '../core/models';
import { pad, todayStr } from '../core/util';

interface Cell {
  date: string;
  day: number;
}

@Component({
  selector: 'app-calendar',
  template: `
    <section class="card calendar" aria-label="Calendario">
      <div class="cal-head">
        <button type="button" class="icon-btn" (click)="shift(-1)" aria-label="Mes anterior">‹</button>
        <strong class="cal-title">{{ title() }}</strong>
        <button type="button" class="icon-btn" (click)="shift(1)" aria-label="Mes siguiente">›</button>
      </div>
      <div class="cal-grid" role="grid">
        @for (w of weekdays; track w) {
          <span class="cal-wd" aria-hidden="true">{{ w }}</span>
        }
        @for (c of cells(); track $index) {
          @if (c) {
            <button
              type="button"
              class="cal-day"
              [class.sel]="c.date === selected()"
              [class.today]="c.date === today"
              [attr.aria-label]="label(c)"
              [attr.aria-current]="c.date === selected() ? 'date' : null"
              (click)="pick.emit(c.date)"
            >
              <span>{{ c.day }}</span>
              @if (marks()[c.date]; as m) {
                @if (m.worst === 'hipo') {
                  <i class="dot hipo"></i>
                } @else if (m.worst === 'hiper') {
                  <i class="dot hiper"></i>
                } @else if (m.hasData) {
                  <i class="dot has"></i>
                }
              }
            </button>
          } @else {
            <span></span>
          }
        }
      </div>
      <div class="cal-legend">
        <span><i class="dot has"></i> con registro</span>
        <span><i class="dot hipo"></i> hipoglucemia</span>
        <span><i class="dot hiper"></i> hiperglucemia</span>
      </div>
    </section>
  `,
})
export class Calendar {
  readonly selected = input.required<string>();
  readonly marks = input<Record<string, DayMark>>({});
  readonly pick = output<string>();
  readonly monthChange = output<string>();

  protected readonly weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  protected readonly today = todayStr();
  private readonly view = linkedSignal(() => this.selected().slice(0, 7));

  protected readonly title = computed(() => {
    const [y, m] = this.view().split('-').map(Number);
    const t = new Date(y, m - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    return t.charAt(0).toUpperCase() + t.slice(1);
  });

  protected readonly cells = computed<Array<Cell | null>>(() => {
    const [y, m] = this.view().split('-').map(Number);
    const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7; // semana que empieza en lunes
    const days = new Date(y, m, 0).getDate();
    const out: Array<Cell | null> = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= days; d++) out.push({ date: `${y}-${pad(m)}-${pad(d)}`, day: d });
    return out;
  });

  protected shift(n: number): void {
    const [y, m] = this.view().split('-').map(Number);
    const d = new Date(y, m - 1 + n, 1);
    const v = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    this.view.set(v);
    this.monthChange.emit(v);
  }

  protected label(c: Cell): string {
    const m = this.marks()[c.date];
    const extra = m?.worst === 'hipo' ? ', con hipoglucemia' : m?.worst === 'hiper' ? ', con hiperglucemia' : m?.hasData ? ', con registro' : '';
    return `${c.day}${extra}`;
  }
}
