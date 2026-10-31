import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DataService } from '../core/data.service';
import {
  Bucket,
  Period,
  buildBuckets,
  buildTrend,
  computeStats,
  periodLabel,
  rangeOf,
  shiftAnchor,
} from '../core/evolution';
import { DayRecord } from '../core/models';
import { fmtNum, todayStr } from '../core/util';

const W = 640;
const M = { l: 44, r: 12, t: 14, b: 30 };

interface Col {
  i: number;
  x: number; // centro
  w: number; // ancho de la columna
  b: Bucket;
}

const f0 = (n: number | null): string => (n === null ? '—' : Math.round(n).toLocaleString('es-ES'));

/**
 * Evolución por semanas, meses y año: resumen de tendencia, gráficas y tabla.
 * Es informativa: no sustituye la valoración del equipo médico.
 */
@Component({
  selector: 'app-evolution',
  template: `
    <section class="card day-head">
      <button type="button" class="icon-btn" (click)="shift(-1)" [attr.aria-label]="'Anterior ' + unit()">‹</button>
      <div class="date-btn static">
        <strong>{{ label() }}</strong>
        <span class="muted">{{ isCurrent() ? 'Periodo actual' : 'Periodo pasado' }}</span>
      </div>
      <button type="button" class="icon-btn" (click)="shift(1)" [attr.aria-label]="'Siguiente ' + unit()" [disabled]="isCurrent()">›</button>
    </section>
    @if (!isCurrent()) {
      <button type="button" class="btn ghost small" (click)="goNow()">Volver a {{ nowLabel() }}</button>
    }

    @if (error()) {
      <section class="card center pad">
        <p class="error">{{ error() }}</p>
        <button type="button" class="btn primary" (click)="reload()">Reintentar</button>
      </section>
    } @else if (loading() && !loaded()) {
      <p class="center muted pad">Cargando los registros…</p>
    } @else if (loaded(); as L) {
      <div [class.is-loading]="loading()">
        @if (stats().n === 0) {
          <section class="card center pad">
            <p class="muted">No hay mediciones registradas en este periodo.</p>
          </section>
        } @else {
          <!-- Resumen de tendencia -->
          <section class="card evo-trend" [class.ok]="trend().tone === 'ok'" [class.warn]="trend().tone === 'atencion'">
            <h3>Tendencia</h3>
            <p class="evo-headline">
              <span aria-hidden="true">{{ trend().dir === 'mejor' ? '▲' : trend().dir === 'peor' ? '▼' : '●' }}</span>
              {{ trend().headline }}
            </p>
            @for (n of trend().notes; track $index) {
              <p class="muted small">{{ n }}</p>
            }
            @if (trend().inside) {
              <p class="muted small">{{ trend().inside }}</p>
            }
          </section>

          <!-- Indicadores -->
          <section class="evo-kpis" aria-label="Resumen del periodo">
            <div class="card kpi">
              <span class="kpi-l">Mediciones</span>
              <strong>{{ stats().n }}</strong>
              <span class="muted small">en {{ stats().days }} {{ stats().days === 1 ? 'día' : 'días' }}</span>
            </div>
            <div class="card kpi">
              <span class="kpi-l">Glucemia media</span>
              <strong>{{ f0(stats().mean) }} <small>mg/dL</small></strong>
              <span class="muted small">{{ f0(stats().min) }}–{{ f0(stats().max) }}</span>
            </div>
            <div class="card kpi">
              <span class="kpi-l">En rango</span>
              <strong>{{ f0(stats().pctIn) }} %</strong>
              <span class="muted small">70–180 mg/dL</span>
            </div>
            <div class="card kpi">
              <span class="kpi-l">Hipoglucemias</span>
              <strong>{{ stats().low }}</strong>
              <span class="muted small">{{ fmt(stats().pctLow, 1) }} % (&lt; 70)</span>
            </div>
            <div class="card kpi">
              <span class="kpi-l">Variabilidad</span>
              <strong>{{ f0(stats().cv) }} <small>%</small></strong>
              <span class="muted small">CV · ideal &lt; 36 %</span>
            </div>
            <div class="card kpi">
              <span class="kpi-l">Insulina rápida</span>
              <strong>{{ stats().rapidPerDay === null ? '—' : fmt(stats().rapidPerDay, 1) }} <small>U/día</small></strong>
              <span class="muted small">lenta {{ stats().lentaPerDay === null ? '—' : fmt(stats().lentaPerDay, 1) + ' U' }}</span>
            </div>
          </section>

          <!-- Gráfica 1: glucemia -->
          <section class="card evo-chart">
            <h3>Glucemia {{ perLabel() }}</h3>
            <svg class="gchart" [attr.viewBox]="'0 0 ' + W + ' ' + H1" role="img" [attr.aria-label]="'Glucemia media y rango de valores ' + perLabel()">
              <rect [attr.x]="M.l" [attr.y]="y1(g1.max)" [attr.width]="W - M.l - M.r" [attr.height]="y1(180) - y1(g1.max)" class="z-high" />
              <rect [attr.x]="M.l" [attr.y]="y1(180)" [attr.width]="W - M.l - M.r" [attr.height]="y1(70) - y1(180)" class="z-range" />
              <rect [attr.x]="M.l" [attr.y]="y1(70)" [attr.width]="W - M.l - M.r" [attr.height]="y1(g1.min) - y1(70)" class="z-low" />
              @for (t of g1.ticks; track t) {
                <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="y1(t)" [attr.y2]="y1(t)" class="grid" />
                <text [attr.x]="M.l - 6" [attr.y]="y1(t) + 4" text-anchor="end" class="axis">{{ t }}</text>
              }
              <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="y1(70)" [attr.y2]="y1(70)" class="limit low" />
              <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="y1(180)" [attr.y2]="y1(180)" class="limit high" />
              @for (c of cols(); track c.i) {
                @if (xLabel(c.i)) {
                  <text [attr.x]="c.x" [attr.y]="H1 - 10" text-anchor="middle" class="axis">{{ c.b.label }}</text>
                }
                @if (c.b.n > 0 && c.b.min !== null && c.b.max !== null) {
                  <line [attr.x1]="c.x" [attr.x2]="c.x" [attr.y1]="y1(c.b.max)" [attr.y2]="y1(c.b.min)" class="evo-band" />
                }
              }
              @for (seg of line1(); track $index) {
                <path [attr.d]="seg" class="measured" />
              }
              @for (c of cols(); track c.i) {
                @if (c.b.mean !== null) {
                  <circle [attr.cx]="c.x" [attr.cy]="y1(c.b.mean)" r="4.5" class="evo-dot" [class.on]="sel() === c.i" />
                }
              }
              @for (c of cols(); track c.i) {
                <rect
                  [attr.x]="c.x - c.w / 2" [attr.y]="M.t" [attr.width]="c.w" [attr.height]="H1 - M.t - M.b"
                  class="evo-hit" tabindex="0" role="button"
                  [attr.aria-label]="describe(c.b)"
                  (mouseenter)="sel.set(c.i)" (focus)="sel.set(c.i)" (click)="toggle(c.i)"
                  (keydown.enter)="toggle(c.i)" (keydown.space)="toggle(c.i); $event.preventDefault()"
                />
              }
            </svg>
            <div class="chart-legend">
              <span><i class="lg line"></i> Media</span>
              <span><i class="lg band"></i> Mínimo–máximo</span>
              <span><i class="lg dash"></i> Límites 70 y 180</span>
            </div>
          </section>

          <!-- Gráfica 2: reparto -->
          <section class="card evo-chart">
            <h3>Tiempo en cada zona {{ perLabel() }}</h3>
            <svg class="gchart" [attr.viewBox]="'0 0 ' + W + ' ' + H2" role="img" aria-label="Porcentaje de mediciones por debajo de 70, en rango y por encima de 180">
              @for (t of [0, 25, 50, 75, 100]; track t) {
                <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="y2(t)" [attr.y2]="y2(t)" class="grid" />
                <text [attr.x]="M.l - 6" [attr.y]="y2(t) + 4" text-anchor="end" class="axis">{{ t }} %</text>
              }
              @for (c of cols(); track c.i) {
                @if (xLabel(c.i)) {
                  <text [attr.x]="c.x" [attr.y]="H2 - 10" text-anchor="middle" class="axis">{{ c.b.label }}</text>
                }
                @if (c.b.n > 0) {
                  @for (s of stack(c); track s.k) {
                    <rect [attr.x]="c.x - barW() / 2" [attr.y]="s.y" [attr.width]="barW()" [attr.height]="s.h" [attr.class]="'evo-seg ' + s.k" />
                  }
                }
                <rect
                  [attr.x]="c.x - c.w / 2" [attr.y]="M.t" [attr.width]="c.w" [attr.height]="H2 - M.t - M.b"
                  class="evo-hit" (mouseenter)="sel.set(c.i)" (click)="toggle(c.i)"
                />
              }
            </svg>
            <div class="chart-legend">
              <span><i class="lg sw lo"></i> Por debajo de 70</span>
              <span><i class="lg sw in"></i> En rango</span>
              <span><i class="lg sw hi"></i> Por encima de 180</span>
            </div>
          </section>

          <!-- Gráfica 3: insulina rápida -->
          @if (insulinMax() > 0) {
            <section class="card evo-chart">
              <h3>Insulina rápida {{ period() === 'anio' ? '(media diaria por mes)' : '(total del día)' }}</h3>
              <svg class="gchart" [attr.viewBox]="'0 0 ' + W + ' ' + H3" role="img" aria-label="Unidades de insulina rápida">
                @for (t of g3.ticks(); track t) {
                  <line [attr.x1]="M.l" [attr.x2]="W - M.r" [attr.y1]="y3(t)" [attr.y2]="y3(t)" class="grid" />
                  <text [attr.x]="M.l - 6" [attr.y]="y3(t) + 4" text-anchor="end" class="axis">{{ t }}</text>
                }
                @for (c of cols(); track c.i) {
                  @if (xLabel(c.i)) {
                    <text [attr.x]="c.x" [attr.y]="H3 - 10" text-anchor="middle" class="axis">{{ c.b.label }}</text>
                  }
                  @if (c.b.rapidPerDay !== null) {
                    <rect [attr.x]="c.x - barW() / 2" [attr.y]="y3(c.b.rapidPerDay)" [attr.width]="barW()" [attr.height]="y3(0) - y3(c.b.rapidPerDay)" rx="3" class="evo-bar" />
                  }
                  <rect
                    [attr.x]="c.x - c.w / 2" [attr.y]="M.t" [attr.width]="c.w" [attr.height]="H3 - M.t - M.b"
                    class="evo-hit" (mouseenter)="sel.set(c.i)" (click)="toggle(c.i)"
                  />
                }
              </svg>
            </section>
          }

          @if (selBucket(); as b) {
            <p class="notice chart-sel" role="status">
              <strong>{{ b.longLabel }}</strong> ·
              @if (b.n) {
                {{ b.n }} {{ b.n === 1 ? 'medición' : 'mediciones' }} · media {{ f0(b.mean) }} mg/dL ({{ f0(b.min) }}–{{ f0(b.max) }}) ·
                {{ f0(b.pctIn) }} % en rango · {{ b.low }} {{ b.low === 1 ? 'hipo' : 'hipos' }}
              } @else {
                sin mediciones
              }
              @if (b.rapidPerDay !== null) { · rápida {{ fmt(b.rapidPerDay, 1) }} U }
            </p>
          } @else {
            <p class="muted small">Toca o pasa el cursor por una columna para ver su detalle.</p>
          }

          <!-- Comparación con el periodo anterior -->
          <section class="card">
            <h3>Comparación con {{ prevName() }}</h3>
            <table class="lines evo-table">
              <caption class="sr-only">Comparación con {{ prevName() }}</caption>
              <thead><tr><th scope="col">Indicador</th><th scope="col">Ahora</th><th scope="col">Antes</th><th scope="col">Cambio</th></tr></thead>
              <tbody>
                @for (c of trend().comparisons; track c.label) {
                  <tr>
                    <th scope="row">{{ c.label }}</th>
                    <td>{{ c.now }}</td>
                    <td>{{ c.before }}</td>
                    <td [class.good]="c.verdict === 'mejor'" [class.bad]="c.verdict === 'peor'">
                      {{ c.delta }}
                      @if (c.verdict === 'mejor') { <span aria-label="mejora">▲</span> }
                      @if (c.verdict === 'peor') { <span aria-label="empeora">▼</span> }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>

          <details class="chart-table card">
            <summary>Ver los valores en una tabla</summary>
            <table class="lines evo-table">
              <caption class="sr-only">Valores {{ perLabel() }}</caption>
              <thead>
                <tr><th scope="col">Periodo</th><th scope="col">Med.</th><th scope="col">Media</th><th scope="col">% rango</th><th scope="col">Hipos</th><th scope="col">U rápida</th></tr>
              </thead>
              <tbody>
                @for (b of buckets(); track b.key) {
                  <tr>
                    <th scope="row">{{ b.longLabel }}</th>
                    <td>{{ b.n }}</td>
                    <td>{{ f0(b.mean) }}</td>
                    <td>{{ b.n ? f0(b.pctIn) : '—' }}</td>
                    <td>{{ b.n ? b.low : '—' }}</td>
                    <td>{{ b.rapidPerDay === null ? '—' : fmt(b.rapidPerDay, 1) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </details>

          <p class="muted small">
            Resumen informativo calculado con las mediciones registradas (no es un monitor continuo, por lo que no equivale a un informe
            de tiempo en rango). No sustituye la valoración del equipo médico.
          </p>
        }
      </div>
    }
  `,
})
export class Evolution {
  private readonly data = inject(DataService);

  readonly period = input.required<Period>();

  protected readonly W = W;
  protected readonly M = M;
  protected readonly H1 = 300;
  protected readonly H2 = 190;
  protected readonly H3 = 180;
  protected readonly f0 = f0;
  protected readonly fmt = fmtNum;

  protected readonly anchor = signal(todayStr());
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly sel = signal<number | null>(null);
  protected readonly loaded = signal<{ cur: DayRecord[]; prev: DayRecord[]; key: string } | null>(null);
  private token = 0;

  constructor() {
    effect(() => {
      const p = this.period();
      const a = this.anchor();
      untracked(() => void this.load(p, a));
    });
  }

  protected unit(): string {
    return this.period() === 'semana' ? 'semana' : this.period() === 'mes' ? 'mes' : 'año';
  }
  protected perLabel(): string {
    return this.period() === 'anio' ? 'por meses' : 'por días';
  }
  protected prevName(): string {
    return this.period() === 'semana' ? 'la semana anterior' : this.period() === 'mes' ? 'el mes anterior' : 'el año anterior';
  }
  protected nowLabel(): string {
    return this.period() === 'semana' ? 'esta semana' : this.period() === 'mes' ? 'este mes' : 'este año';
  }
  protected readonly label = computed(() => periodLabel(this.period(), this.anchor()));
  protected isCurrent(): boolean {
    const r = rangeOf(this.period(), this.anchor());
    const t = todayStr();
    return r.from <= t && t <= r.to;
  }

  protected shift(n: number): void {
    this.sel.set(null);
    this.anchor.set(shiftAnchor(this.period(), this.anchor(), n));
  }
  protected goNow(): void {
    this.sel.set(null);
    this.anchor.set(todayStr());
  }
  protected reload(): void {
    void this.load(this.period(), this.anchor());
  }

  private async load(period: Period, anchor: string): Promise<void> {
    const my = ++this.token;
    this.loading.set(true);
    this.error.set('');
    this.sel.set(null);
    try {
      const r = rangeOf(period, anchor);
      const p = rangeOf(period, shiftAnchor(period, anchor, -1));
      const [cur, prev] = await Promise.all([this.data.getRange(r.from, r.to), this.data.getRange(p.from, p.to)]);
      if (my !== this.token) return;
      this.loaded.set({ cur, prev, key: `${period}|${anchor}` });
    } catch (e) {
      if (my !== this.token) return;
      this.error.set('No se han podido cargar los registros. ' + (e instanceof Error ? e.message : ''));
    } finally {
      if (my === this.token) this.loading.set(false);
    }
  }

  protected readonly stats = computed(() => computeStats(this.loaded()?.cur ?? []));
  protected readonly trend = computed(() => buildTrend(this.period(), this.loaded()?.cur ?? [], this.loaded()?.prev ?? []));
  protected readonly buckets = computed<Bucket[]>(() => {
    const l = this.loaded();
    return l ? buildBuckets(this.period(), rangeOf(this.period(), this.anchor()), l.cur) : [];
  });

  protected readonly cols = computed<Col[]>(() => {
    const bs = this.buckets();
    const w = (W - M.l - M.r) / Math.max(1, bs.length);
    return bs.map((b, i) => ({ i, x: M.l + w * i + w / 2, w, b }));
  });
  protected barW(): number {
    const c = this.cols();
    return Math.max(4, Math.min(34, (c[0]?.w ?? 20) * 0.7));
  }
  /** En el eje X de un mes solo se rotulan algunos días para que no se amontonen. */
  protected xLabel(i: number): boolean {
    if (this.period() !== 'mes') return true;
    const n = this.buckets().length;
    return i === 0 || (i + 1) % 5 === 0 || i === n - 1;
  }

  /* ---- gráfica 1 ---- */
  protected get g1(): { min: number; max: number; ticks: number[] } {
    const mx = Math.max(0, ...this.buckets().map((b) => b.max ?? 0));
    const max = Math.max(250, Math.ceil((mx + 15) / 50) * 50);
    const ticks: number[] = [];
    for (let g = 50; g <= max; g += 50) ticks.push(g);
    return { min: 40, max, ticks };
  }
  protected y1(g: number): number {
    const { min, max } = this.g1;
    return M.t + (1 - (Math.min(Math.max(g, min), max) - min) / (max - min)) * (this.H1 - M.t - M.b);
  }
  /** La línea de medias se corta donde hay días sin mediciones. */
  protected readonly line1 = computed<string[]>(() => {
    const out: string[] = [];
    let cur = '';
    for (const c of this.cols()) {
      if (c.b.mean === null) {
        if (cur) out.push(cur);
        cur = '';
        continue;
      }
      cur += `${cur ? 'L' : 'M'}${c.x.toFixed(1)} ${this.y1(c.b.mean).toFixed(1)}`;
    }
    if (cur) out.push(cur);
    return out;
  });

  /* ---- gráfica 2 ---- */
  protected y2(pct: number): number {
    return M.t + (1 - pct / 100) * (this.H2 - M.t - M.b);
  }
  /** Segmentos apilados de abajo (hipos) a arriba (altas), con 2 px de separación entre ellos. */
  protected stack(c: Col): Array<{ k: string; y: number; h: number }> {
    const parts = [
      { k: 'lo', v: c.b.pctLow },
      { k: 'in', v: c.b.pctIn },
      { k: 'hi', v: c.b.pctHigh },
    ].filter((p) => p.v > 0);
    const out: Array<{ k: string; y: number; h: number }> = [];
    let acc = 0;
    for (const p of parts) {
      const top = this.y2(acc + p.v);
      const bottom = this.y2(acc);
      const gap = parts.length > 1 ? 1 : 0;
      out.push({ k: p.k, y: top + gap, h: Math.max(1, bottom - top - gap * 2) });
      acc += p.v;
    }
    return out;
  }

  /* ---- gráfica 3 ---- */
  protected readonly insulinMax = computed(() => Math.max(0, ...this.buckets().map((b) => b.rapidPerDay ?? 0)));
  protected readonly g3 = {
    ticks: computed<number[]>(() => {
      const max = this.insulinMax();
      const step = max > 40 ? 20 : max > 20 ? 10 : max > 8 ? 5 : 2;
      const out: number[] = [];
      for (let v = 0; v <= Math.ceil(max / step) * step; v += step) out.push(v);
      return out;
    }),
  };
  protected y3(v: number): number {
    const t = this.g3.ticks();
    const top = t[t.length - 1] || 1;
    return M.t + (1 - v / top) * (this.H3 - M.t - M.b);
  }

  /* ---- detalle ---- */
  protected readonly selBucket = computed<Bucket | null>(() => {
    const i = this.sel();
    return i === null ? null : (this.buckets()[i] ?? null);
  });
  protected toggle(i: number): void {
    this.sel.update((c) => (c === i ? null : i));
  }
  protected describe(b: Bucket): string {
    return b.n ? `${b.longLabel}: ${b.n} mediciones, media ${f0(b.mean)} mg/dL, ${f0(b.pctIn)} % en rango` : `${b.longLabel}: sin mediciones`;
  }
}
