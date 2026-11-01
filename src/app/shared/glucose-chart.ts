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

@Component({
  selector: 'app-glucose-chart',
  template: `
    @if (v(); as g) {
      @if (!g.hasData) {
        <p class="muted">Todavía no hay mediciones con hora para dibujar la curva.</p>
      } @else {
        <svg
          class="gchart"
          [attr.viewBox]="'0 0 ' + W + ' ' + H"
          role="img"
          aria-label="Curva de glucemia del día con las mediciones, las dosis y la evolución prevista"
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
        </svg>

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

    return { hasData, x, y, xTicks, yTicks, yMin, yMax, dots, line, curves, doses, measured, sensorPaths };
  });
}
