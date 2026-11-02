import { Component, computed, input, signal } from '@angular/core';
import { classify } from '../core/glucose';
import { seriesPoints, seriesStats } from '../core/libre-import';
import { DayAnalysis, MeasuredPoint, fmtTime } from '../core/predict';
import { fmtNum } from '../core/util';

const W = 640;
const H = 340;
const M = { l: 46, r: 24, t: 18, b: 34 };

interface Tick {
  pos: number;
  label: string;
}
interface Dot {
  x: number;
  y: number;
  color: string;
  shape: 'circle' | 'diamond' | 'triangle';
  p: MeasuredPoint;
  index: number;
}

const CLS_COLOR: Record<string, string> = {
  hipo: 'var(--c-hipo)',
  tendHipo: 'var(--c-tendhipo)',
  estable: 'var(--c-estable)',
  tendHiper: 'var(--c-tendhiper)',
  hiper: 'var(--c-hiper)',
  enRango: 'var(--c-rango)',
  alta: 'var(--c-alta)',
};

const KIND_LABEL: Record<MeasuredPoint['kind'], string> = {
  before: 'Antes de comer',
  after: 'Al terminar',
  monitor: 'Monitor',
  capilar: 'Capilar',
  ejercicio: 'Ejercicio',
};

interface ScrubView {
  x: number;
  y: number;
  bx: number;
  by: number;
  g: number;
  time: string;
  color: string;
}

interface ChartView {
  x: (t: number) => number;
  y: (g: number) => number;
  scrub: Array<{ t: number; g: number }>;
  t0: number;
  t1: number;
}

/** Índice del punto más cercano a t en una lista ordenada por t (-1 si está vacía). */
function nearest(a: ReadonlyArray<{ t: number }>, t: number): number {
  if (!a.length) return -1;
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(a[lo - 1].t - t) <= Math.abs(a[lo].t - t) ? lo - 1 : lo;
}

@Component({
  selector: 'app-glucose-chart',
  template: `
    @if (v(); as g) {
      @if (!g.hasData) {
        <p class="muted">Todavía no hay mediciones con hora para dibujar la curva.</p>
      } @else {
        <svg
          class="gchart"
          [class.scrubbable]="g.scrub.length > 0"
          [attr.viewBox]="'0 0 ' + W + ' ' + H"
          [attr.role]="g.scrub.length ? 'group' : 'img'"
          [attr.tabindex]="g.scrub.length ? 0 : null"
          aria-label="Curva de glucemia del día con las mediciones, las dosis y la evolución prevista"
          (pointerdown)="onPointer($event, g)"
          (pointermove)="onPointer($event, g)"
          (pointerleave)="onLeave($event)"
          (keydown)="onKey($event, g)"
        >
          <!-- zonas -->
          <rect [attr.x]="M.l" [attr.y]="g.y(g.yMax)" [attr.width]="W - M.l - M.r" [attr.height]="g.y(180) - g.y(g.yMax)" class="z-high" />
          <rect [attr.x]="M.l" [attr.y]="g.y(180)" [attr.width]="W - M.l - M.r" [attr.height]="g.y(70) - g.y(180)" class="z-range" />
          <rect [attr.x]="M.l" [attr.y]="g.y(70)" [attr.width]="W - M.l - M.r" [attr.height]="g.y(g.yMin) - g.y(70)" class="z-low" />

          <!-- rejilla y ejes -->
          @for (t of g.yTicks; track t.pos) {
            <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="g.y(t.pos)" [attr.y2]="g.y(t.pos)" class="grid" />
            <text [attr.x]="M.l - 6" [attr.y]="g.y(t.pos) + 4" text-anchor="end" class="axis">{{ t.label }}</text>
          }
          @for (t of g.xTicks; track t.pos) {
            <line [attr.x1]="g.x(t.pos)" [attr.x2]="g.x(t.pos)" [attr.y1]="M.t" [attr.y2]="H - M.b" class="grid v" />
            <text [attr.x]="g.x(t.pos)" [attr.y]="H - M.b + 16" text-anchor="middle" class="axis">{{ t.label }}</text>
          }
          <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="g.y(70)" [attr.y2]="g.y(70)" class="limit low" />
          <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="g.y(180)" [attr.y2]="g.y(180)" class="limit high" />

          <!-- dosis -->
          @for (d of g.doses; track $index) {
            <line [attr.x1]="d.x" [attr.x2]="d.x" [attr.y1]="M.t" [attr.y2]="H - M.b" class="dose-line" />
            <text [attr.x]="d.x + 3" [attr.y]="M.t + 10 + d.row * 11" class="dose-label">{{ d.text }}</text>
          }

          <!-- curvas previstas -->
          @for (c of g.curves; track c.name) {
            <path [attr.d]="c.d" class="pred" />
          }

          <!-- sensor continuo (importado del CSV del monitor) -->
          @for (seg of g.sensorPaths; track $index) {
            <path [attr.d]="seg" class="sensor-line" />
          }

          <!-- medido -->
          <path [attr.d]="g.line" class="measured" />
          @for (p of g.dots; track p.index) {
            @switch (p.shape) {
              @case ('diamond') {
                <rect
                  [attr.x]="p.x - 5" [attr.y]="p.y - 5" width="10" height="10"
                  [attr.transform]="'rotate(45 ' + p.x + ' ' + p.y + ')'"
                  [attr.fill]="p.color" class="dot" (click)="pick(p.index)"
                />
              }
              @case ('triangle') {
                <path [attr.d]="'M' + p.x + ' ' + (p.y - 6) + 'L' + (p.x + 6) + ' ' + (p.y + 5) + 'L' + (p.x - 6) + ' ' + (p.y + 5) + 'Z'" [attr.fill]="p.color" class="dot" (click)="pick(p.index)" />
              }
              @default {
                <circle [attr.cx]="p.x" [attr.cy]="p.y" r="5.5" [attr.fill]="p.color" class="dot" (click)="pick(p.index)" />
              }
            }
          }

          <!-- punto que recorre la curva -->
          @if (scrubAt(g); as c) {
            <line [attr.x1]="c.x" [attr.x2]="c.x" [attr.y1]="M.t" [attr.y2]="H - M.b" class="scrub-line" />
            <circle [attr.cx]="c.x" [attr.cy]="c.y" r="7" [attr.fill]="c.color" class="scrub-dot" />
            <g [attr.transform]="'translate(' + c.bx + ' ' + c.by + ')'" class="scrub-tip">
              <rect width="150" height="46" rx="8" />
              <text x="75" y="19" text-anchor="middle" class="scrub-time">{{ c.time }}</text>
              <text x="75" y="39" text-anchor="middle" class="scrub-val">{{ c.g }} mg/dL</text>
            </g>
          }
        </svg>

        @if (g.scrub.length) {
          <p class="muted small scrub-hint" [attr.aria-live]="'polite'">
            @if (scrubAt(g); as c) {
              <strong>{{ c.time }}</strong> · {{ c.g }} mg/dL · sensor
            } @else {
              Desliza el dedo o el ratón por la gráfica (o usa las flechas del teclado) para ver la hora y el valor.
            }
          </p>
        }

        <div class="chart-legend">
          @if (g.sensorPaths.length) {
            <span><i class="lg sensor"></i> Sensor continuo</span>
          }
          <span><i class="lg line"></i> Medido</span>
          <span><i class="lg dash"></i> Previsto</span>
          <span><i class="lg dot"></i> Monitor / comida</span>
          <span><i class="lg dia"></i> Capilar</span>
          <span><i class="lg tri"></i> Ejercicio</span>
          <span><i class="lg dose"></i> Dosis</span>
        </div>

        @if (stats(); as st) {
          <p class="muted small sensor-stats">
            Sensor: {{ st.n }} lecturas · media {{ fmt(st.mean, 0) }} mg/dL · de {{ st.min }} a {{ st.max }} ·
            {{ fmt(st.inRange, 0) }} % en rango (70–180) · {{ fmt(st.low, 0) }} % por debajo · {{ fmt(st.high, 0) }} % por encima
          </p>
        }

        @if (sel(); as s) {
          <p class="notice chart-sel" role="status">
            <strong>{{ fmtT(s.t) }}</strong> · {{ s.g }} mg/dL · {{ kindLabel(s.kind) }} · {{ s.label }}
            @if (s.note) { · «{{ s.note }}» }
          </p>
        } @else {
          <p class="muted small">Toca un punto para ver su detalle.</p>
        }

        <details class="chart-table">
          <summary>Ver los valores en una tabla</summary>
          <table class="lines">
            <caption class="sr-only">Mediciones del día</caption>
            <thead><tr><th scope="col">Hora</th><th scope="col">mg/dL</th><th scope="col">Origen</th></tr></thead>
            <tbody>
              @for (p of g.measured; track $index) {
                <tr><td>{{ fmtT(p.t) }}</td><td>{{ p.g }}</td><td>{{ p.label }}</td></tr>
              }
            </tbody>
          </table>
        </details>
      }
    }
  `,
})
export class GlucoseChart {
  readonly analysis = input.required<DayAnalysis>();
  /** Serie continua del sensor del día (`DayRecord.sensor`). */
  readonly sensor = input<number[] | undefined>(undefined);
  protected readonly fmt = fmtNum;
  protected readonly stats = computed(() => {
    const st = seriesStats(this.sensor());
    return st.n ? st : null;
  });
  protected readonly W = W;
  protected readonly H = H;
  protected readonly M = M;
  protected readonly fmtT = fmtTime;
  protected readonly kindLabel = (k: MeasuredPoint['kind']) => KIND_LABEL[k];
  private readonly selIdx = signal<number | null>(null);

  protected readonly sel = computed(() => {
    const i = this.selIdx();
    const a = this.analysis();
    return i === null ? null : (a.measured[i] ?? null);
  });

  /** Punto de la curva que se está recorriendo (índice en `scrub`). */
  private readonly scrubIdx = signal<number | null>(null);

  /** Posición, color y recuadro del punto recorrido (null si no hay ninguno). */
  protected scrubAt(g: ChartView): ScrubView | null {
    const i = this.scrubIdx();
    const p = i === null ? null : g.scrub[i];
    if (!p) return null;
    const x = g.x(p.t);
    const y = g.y(p.g);
    const cls = classify(p.g, null)?.cls ?? 'enRango';
    // el recuadro va a un lado del punto y se da la vuelta cerca de los bordes
    const bx = x + 14 + 150 > W - M.r ? x - 14 - 150 : x + 14;
    const by = Math.min(Math.max(y - 23, M.t + 2), H - M.b - 48);
    return { x, y, bx, by, g: p.g, time: fmtTime(p.t), color: CLS_COLOR[cls] };
  }

  protected onPointer(ev: PointerEvent, g: ChartView): void {
    if (!g.scrub.length) return;
    const svg = ev.currentTarget as SVGSVGElement;
    const r = svg.getBoundingClientRect();
    if (!r.width) return;
    // si solo se pasa el ratón se sigue el puntero; con dedo o ratón pulsado, también
    if (ev.pointerType === 'mouse' && ev.type === 'pointerdown') svg.setPointerCapture?.(ev.pointerId);
    // eventos fuera del gráfico (p. ej. un movimiento de ratón que genera el navegador al hacer scroll) no cambian nada
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
    const xs = ((ev.clientX - r.left) / r.width) * W;
    const t = g.t0 + ((xs - M.l) / (W - M.l - M.r)) * (g.t1 - g.t0);
    const i = nearest(g.scrub, t);
    // si en ese punto no hay lectura (sensor apagado o sin datos) no se enseña nada
    this.scrubIdx.set(i >= 0 && Math.abs(g.scrub[i].t - t) <= 20 ? i : null);
  }

  protected onLeave(ev: PointerEvent): void {
    // con el dedo el punto se queda donde se soltó; con el ratón desaparece al salir
    if (ev.pointerType === 'mouse') this.scrubIdx.set(null);
  }

  protected onKey(ev: KeyboardEvent, g: ChartView): void {
    const n = g.scrub.length;
    if (!n) return;
    const cur = this.scrubIdx();
    let next: number | null = cur;
    if (ev.key === 'ArrowRight') next = cur === null ? 0 : Math.min(n - 1, cur + (ev.shiftKey ? 12 : 1));
    else if (ev.key === 'ArrowLeft') next = cur === null ? n - 1 : Math.max(0, cur - (ev.shiftKey ? 12 : 1));
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = n - 1;
    else if (ev.key === 'Escape') next = null;
    else return;
    ev.preventDefault();
    this.scrubIdx.set(next);
  }

  protected pick(i: number): void {
    this.selIdx.update((c) => (c === i ? null : i));
  }

  protected readonly v = computed(() => {
    const a = this.analysis();
    const measured = a.measured;
    const preds = a.episodes.filter((e) => e.points.length > 1);
    const sp = seriesPoints(this.sensor());
    const hasData = measured.length > 0 || sp.length > 0;

    // Rango horario: ajustado a los datos, mínimo 6 h, en horas redondas
    const ts = [...sp.map((p) => p.t), ...measured.map((p) => p.t), ...a.doses.map((d) => d.t), ...preds.flatMap((e) => [e.points[0].t, e.points[e.points.length - 1].t])];
    let t0 = ts.length ? Math.min(...ts) : 360;
    let t1 = ts.length ? Math.max(...ts) : 1320;
    t0 = Math.max(0, Math.floor((t0 - 30) / 60) * 60);
    t1 = Math.min(1440, Math.ceil((t1 + 30) / 60) * 60);
    if (t1 - t0 < 360) t1 = Math.min(1440, t0 + 360);
    if (t1 - t0 < 360) t0 = Math.max(0, t1 - 360);

    const vals = [...sp.map((p) => p.g), ...measured.map((p) => p.g), ...preds.flatMap((e) => e.points.map((p) => p.g))];
    const yMin = 40;
    const yMax = Math.max(250, Math.ceil((Math.max(0, ...vals) + 15) / 50) * 50);

    const x = (t: number) => M.l + ((t - t0) / (t1 - t0)) * (W - M.l - M.r);
    const y = (g: number) => M.t + (1 - (Math.min(Math.max(g, yMin), yMax) - yMin) / (yMax - yMin)) * (H - M.t - M.b);

    const stepH = t1 - t0 > 840 ? 120 : 60;
    const xTicks: Tick[] = [];
    for (let t = Math.ceil(t0 / stepH) * stepH; t <= t1; t += stepH) xTicks.push({ pos: t, label: fmtTime(t) });
    const yTicks: Tick[] = [];
    for (let g = 50; g <= yMax; g += 50) yTicks.push({ pos: g, label: String(g) });

    const dots: Dot[] = measured.map((p, index) => {
      const c = classify(p.g, p.arrow);
      return {
        x: x(p.t),
        y: y(p.g),
        color: CLS_COLOR[c?.cls ?? 'enRango'],
        shape: p.kind === 'capilar' ? 'diamond' : p.kind === 'ejercicio' ? 'triangle' : 'circle',
        p,
        index,
      };
    });
    const line = measured.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.g).toFixed(1)}`).join(' ');

    // una línea por tramo: si faltan lecturas más de 20 min (sensor apagado, calentamiento…) no se unen
    const sensorPaths: string[] = [];
    let cur = '';
    let prev = -999;
    for (const p of sp) {
      const pt = `${x(p.t).toFixed(1)} ${y(p.g).toFixed(1)}`;
      cur = p.t - prev > 20 || !cur ? (cur && sensorPaths.push(cur), `M${pt}`) : `${cur}L${pt}`;
      prev = p.t;
    }
    if (cur) sensorPaths.push(cur);

    const curves = preds.map((e) => ({
      name: e.mealId,
      d: e.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.g).toFixed(1)}`).join(' '),
    }));

    // dosis: si dos etiquetas quedan muy juntas, la segunda baja una fila
    const doses: Array<{ x: number; text: string; row: number }> = [];
    let lastX = -999;
    let row = 0;
    for (const d of [...a.doses].sort((p, q) => p.t - q.t)) {
      const dx = x(d.t);
      row = dx - lastX < 58 ? (row + 1) % 3 : 0;
      lastX = dx;
      const lenta = d.label.includes('lenta');
      doses.push({ x: dx, row, text: `${lenta ? 'L' : 'R'} ${d.units.toLocaleString('es-ES')} U` });
    }

    // lo que se puede recorrer: la serie continua del sensor y, si no la hay, las mediciones anotadas
    const scrub: Array<{ t: number; g: number }> = sp.length ? sp : [...measured].sort((a, b) => a.t - b.t).map((p) => ({ t: p.t, g: p.g }));

    return { hasData, x, y, xTicks, yTicks, yMin, yMax, dots, line, curves, doses, measured, sensorPaths, scrub, t0, t1 };
  });
}
