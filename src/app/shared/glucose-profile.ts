import { Component, computed, input } from '@angular/core';
import { AgpBin } from '../core/agp';
import { fmtTime } from '../core/predict';

const W = 640;
const H = 270;
const M = { l: 46, r: 16, t: 12, b: 30 };

/**
 * Perfil de glucosa por hora del día (AGP): mediana, la franja donde está la mitad de las lecturas (25–75) y donde está el 90 % (5–95).
 * Se usa para el día completo y para la noche (rango horario recortado). Los tramos con pocas lecturas se dejan en blanco.
 */
@Component({
  selector: 'app-glucose-profile',
  template: `
    @if (v(); as g) {
      @if (!g.any) {
        <p class="muted">No hay lecturas suficientes en cada franja horaria para dibujar el perfil.</p>
      } @else {
        <svg class="gchart agp" [attr.viewBox]="'0 0 ' + W + ' ' + H" role="img" [attr.aria-label]="label()">
          <rect [attr.x]="M.l" [attr.y]="g.y(g.yMax)" [attr.width]="W - M.l - M.r" [attr.height]="g.y(180) - g.y(g.yMax)" class="z-high" />
          <rect [attr.x]="M.l" [attr.y]="g.y(180)" [attr.width]="W - M.l - M.r" [attr.height]="g.y(70) - g.y(180)" class="z-range" />
          <rect [attr.x]="M.l" [attr.y]="g.y(70)" [attr.width]="W - M.l - M.r" [attr.height]="g.y(g.yMin) - g.y(70)" class="z-low" />
          @for (t of g.yTicks; track t) {
            <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="g.y(t)" [attr.y2]="g.y(t)" class="grid" />
            <text [attr.x]="M.l - 6" [attr.y]="g.y(t) + 4" text-anchor="end" class="axis">{{ t }}</text>
          }
          @for (t of g.xTicks; track t) {
            <line [attr.x1]="g.x(t)" [attr.x2]="g.x(t)" [attr.y1]="M.t" [attr.y2]="H - M.b" class="grid v" />
            <text [attr.x]="g.x(t)" [attr.y]="H - M.b + 16" text-anchor="middle" class="axis">{{ fmtT(t) }}</text>
          }
          <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="g.y(70)" [attr.y2]="g.y(70)" class="limit low" />
          <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="g.y(180)" [attr.y2]="g.y(180)" class="limit high" />
          @for (s of g.segments; track $index) {
            <path [attr.d]="s.outer" class="agp-outer" />
            <path [attr.d]="s.inner" class="agp-inner" />
            <path [attr.d]="s.median" class="agp-median" />
          }
        </svg>
        <div class="chart-legend">
          <span><i class="lg agp-med"></i> Mediana</span>
          <span><i class="lg agp-in"></i> Mitad de las lecturas (25–75 %)</span>
          <span><i class="lg agp-out"></i> 9 de cada 10 lecturas (5–95 %)</span>
        </div>
        <details class="chart-table">
          <summary>Ver los valores en una tabla</summary>
          <table class="lines">
            <caption class="sr-only">Perfil de glucosa por franja horaria</caption>
            <thead>
              <tr><th scope="col">Hora</th><th scope="col">Lecturas</th><th scope="col">5 %</th><th scope="col">25 %</th><th scope="col">Mediana</th><th scope="col">75 %</th><th scope="col">95 %</th></tr>
            </thead>
            <tbody>
              @for (b of g.rows; track b.t) {
                <tr>
                  <td>{{ fmtT(b.t) }}</td><td>{{ b.n }}</td>
                  @if (b.ok) {
                    <td>{{ r(b.p5) }}</td><td>{{ r(b.p25) }}</td><td>{{ r(b.p50) }}</td><td>{{ r(b.p75) }}</td><td>{{ r(b.p95) }}</td>
                  } @else {
                    <td colspan="5" class="muted">pocas lecturas</td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </details>
      }
    }
  `,
})
export class GlucoseProfile {
  readonly bins = input.required<AgpBin[]>();
  /** Tramo horario que se dibuja (min del día). */
  readonly from = input(0);
  readonly to = input(1440);
  /** Texto para lectores de pantalla. */
  readonly label = input('Perfil de glucosa por hora del día');

  protected readonly W = W;
  protected readonly H = H;
  protected readonly M = M;
  protected readonly fmtT = fmtTime;
  protected readonly r = (x: number): number => Math.round(x);

  protected readonly v = computed(() => {
    const t0 = this.from();
    const t1 = this.to();
    const all = this.bins().filter((b) => b.t >= t0 && b.t < t1);
    const rows = all.map((b) => ({ ...b, ok: Number.isFinite(b.p50) }));
    const valid = rows.filter((b) => b.ok);
    const any = valid.length > 1;
    const hi = valid.length ? Math.max(...valid.map((b) => b.p95)) : 250;
    const lo = valid.length ? Math.min(...valid.map((b) => b.p5)) : 70;
    const yMax = Math.max(250, Math.ceil((hi + 10) / 50) * 50);
    const yMin = lo < 50 ? 20 : 40;
    const x = (t: number) => M.l + ((t - t0) / (t1 - t0)) * (W - M.l - M.r);
    const y = (g: number) => M.t + (1 - (Math.min(Math.max(g, yMin), yMax) - yMin) / (yMax - yMin)) * (H - M.t - M.b);

    const span = t1 - t0;
    const step = span <= 480 ? 60 : span <= 900 ? 120 : 180;
    const xTicks: number[] = [];
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) xTicks.push(t);
    const yTicks: number[] = [];
    for (let g = yMin === 20 ? 50 : 50; g <= yMax; g += 50) yTicks.push(g);

    // tramos continuos de franjas con datos; cada franja se dibuja en su punto medio
    const binSize = all.length > 1 ? all[1].t - all[0].t : 30;
    const groups: Array<typeof rows> = [];
    let cur: typeof rows = [];
    for (const b of rows) {
      if (b.ok) cur.push(b);
      else if (cur.length) (groups.push(cur), (cur = []));
    }
    if (cur.length) groups.push(cur);
    const poly = (g: typeof rows, up: 'p95' | 'p75', down: 'p5' | 'p25'): string =>
      g.map((b, i) => `${i ? 'L' : 'M'}${x(b.t + binSize / 2).toFixed(1)} ${y(b[up]).toFixed(1)}`).join('') +
      [...g].reverse().map((b) => `L${x(b.t + binSize / 2).toFixed(1)} ${y(b[down]).toFixed(1)}`).join('') +
      'Z';
    const segments = groups
      .filter((g) => g.length > 1)
      .map((g) => ({
        outer: poly(g, 'p95', 'p5'),
        inner: poly(g, 'p75', 'p25'),
        median: g.map((b, i) => `${i ? 'L' : 'M'}${x(b.t + binSize / 2).toFixed(1)} ${y(b.p50).toFixed(1)}`).join(' '),
      }));
    return { any, x, y, yMin, yMax, xTicks, yTicks, segments, rows };
  });
}
