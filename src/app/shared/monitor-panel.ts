import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Calibration,
  GroupRow,
  MIN_BACKTEST,
  MIN_GROUP,
  MIN_PAIRS,
  MIN_RELIABLE,
  PAIR_MAX_GAP_MIN,
  WINDOW_DAYS,
  sensorDayOf,
} from '../core/calibration';
import { CalibrationService } from '../core/calibration.service';
import { DataService } from '../core/data.service';
import { fmtTime } from '../core/predict';
import { fmtNum, todayStr } from '../core/util';

const W = 320;
const P = { l: 40, r: 12, t: 12, b: 34 };

const sgn = (n: number | null, d = 0): string => (n === null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + fmtNum(Math.abs(n), d));

/** Fiabilidad del monitor frente a las glucemias capilares, y registro de los cambios de sensor. */
@Component({
  selector: 'app-monitor-panel',
  imports: [FormsModule],
  template: `
    @if (calib.error()) {
      <section class="card center pad">
        <p class="error">{{ calib.error() }}</p>
        <button type="button" class="btn primary" (click)="calib.reload()">Reintentar</button>
      </section>
    } @else if (!cal()) {
      <p class="center muted pad">Analizando los últimos {{ window }} días…</p>
    } @else if (cal(); as c) {
      <section class="card mon-status" [class.ok]="c.status === 'fiable'" [class.warn]="c.status === 'sin-mejora'">
        <h3>Fiabilidad del monitor</h3>
        <p class="evo-headline">{{ headline(c) }}</p>
        <div class="mon-progress" role="progressbar" [attr.aria-valuenow]="c.n" aria-valuemin="0" [attr.aria-valuemax]="reliable" aria-label="Pares monitor–capilar reunidos">
          <span [style.width.%]="progress(c)"></span>
        </div>
        <p class="muted small">{{ c.n }} {{ c.n === 1 ? 'par reunido' : 'pares reunidos' }} (hacen falta {{ reliable }} para dar avisos fiables) · últimos {{ window }} días.</p>
        <p class="muted small">
          Un <strong>par</strong> es un capilar con una lectura del monitor a menos de {{ gap }} minutos. Cuantos más pares, más fiable es lo
          aprendido: es preferible tardar meses a avisar con pocos datos. Los avisos solo aparecen en las lecturas cuando el aprendizaje
          se ha comprobado con datos que todavía no conocía.
        </p>
      </section>

      <!-- Sensor -->
      <section class="card">
        <h3>Sensor del monitor</h3>
        <p>
          @if (currentDay(); as d) {
            Hoy es el <strong>día {{ d }}</strong> del sensor actual.
          } @else {
            No hay un cambio de sensor reciente anotado. Anótalo para estudiar si el monitor se desvía más al principio o al final.
          }
        </p>
        <div class="mon-sensor-form">
          <div class="field">
            <label for="mon-sensor-date">Fecha del cambio de sensor</label>
            <input id="mon-sensor-date" type="date" [max]="today" [ngModel]="newSensor()" (ngModelChange)="newSensor.set($event)" />
          </div>
          <button type="button" class="btn small primary" (click)="addSensor()">Anotar cambio</button>
        </div>
        @if (msg()) {
          <p class="notice" role="status">{{ msg() }}</p>
        }
        @if (sensors().length) {
          <ul class="mon-sensors">
            @for (s of sensors(); track s) {
              <li>
                <span>{{ s }}</span>
                <button type="button" class="icon-btn" (click)="removeSensor(s)" [attr.aria-label]="'Quitar el cambio de sensor del ' + s">×</button>
              </li>
            }
          </ul>
        }
      </section>

      @if (c.n === 0) {
        <section class="card center pad">
          <p class="muted">
            Todavía no hay pares. Registra una <strong>«Medición post…»</strong> de tipo <strong>capilar</strong> con la hora real, y una lectura del monitor
            (la de antes o después de comer, o una medición de monitor) en los {{ gap }} minutos de diferencia.
          </p>
        </section>
      } @else {
        <section class="evo-kpis" aria-label="Resumen">
          <div class="card kpi">
            <span class="kpi-l">Diferencia media</span>
            <strong>{{ sgn(c.overall.bias) }} <small>mg/dL</small></strong>
            <span class="muted small">monitor − capilar @if (c.overall.ci !== null) { · ±{{ fmt(c.overall.ci, 0) }} }</span>
          </div>
          <div class="card kpi">
            <span class="kpi-l">Error medio</span>
            <strong>{{ fmt(c.overall.mae, 0) }} <small>mg/dL</small></strong>
            <span class="muted small">sin corregir</span>
          </div>
          <div class="card kpi">
            <span class="kpi-l">Concordancia</span>
            <strong>{{ fmt(c.within15, 0) }} <small>%</small></strong>
            <span class="muted small">±15 mg/dL (&lt;100) o ±15 %</span>
          </div>
          <div class="card kpi">
            <span class="kpi-l">Hipos capilares</span>
            <strong>{{ c.hypo.detected }} / {{ c.hypo.n }}</strong>
            <span class="muted small">las marcó también el monitor · {{ c.hypo.falseAlarms }} falsas alarmas</span>
          </div>
        </section>

        @if (c.test.evaluated > 0 && c.test.maeRaw !== null && c.test.maeCorrected !== null) {
          <section class="card">
            <h3>¿Está funcionando el aprendizaje?</h3>
            <p>
              En {{ c.test.evaluated }} comprobaciones sobre datos que aún no había visto, el monitor sin corregir se desvía
              <strong>{{ fmt(c.test.maeRaw, 1) }} mg/dL</strong> de media y con la corrección aprendida
              <strong>{{ fmt(c.test.maeCorrected, 1) }} mg/dL</strong>
              ({{ (c.test.improvement ?? 0) >= 0 ? 'mejora' : 'empeora' }} un {{ fmt(abs(c.test.improvement ?? 0) * 100, 0) }} %).
            </p>
            @if (c.test.evaluated < minBack) {
              <p class="muted small">Aún son pocas comprobaciones ({{ c.test.evaluated }} de {{ minBack }}): no se saca ninguna conclusión.</p>
            }
          </section>
        }

        <!-- Gráfica monitor frente a capilar -->
        <section class="card evo-chart">
          <h3>Monitor frente a capilar</h3>
          <svg class="gchart scatter" [attr.viewBox]="'0 0 ' + W + ' ' + W" role="img" aria-label="Cada punto es un par: capilar en horizontal y monitor en vertical">
            @for (t of ticks(); track t) {
              <line [attr.x1]="P.l" [attr.x2]="W - P.r" [attr.y1]="sy(t)" [attr.y2]="sy(t)" class="grid" />
              <text [attr.x]="P.l - 5" [attr.y]="sy(t) + 4" text-anchor="end" class="axis">{{ t }}</text>
              <text [attr.x]="sx(t)" [attr.y]="W - P.b + 15" text-anchor="middle" class="axis">{{ t }}</text>
            }
            <line [attr.x1]="sx(lo)" [attr.y1]="sy(lo)" [attr.x2]="sx(hi())" [attr.y2]="sy(hi())" class="limit high" />
            @for (p of c.pairs; track $index) {
              <circle [attr.cx]="sx(p.cap)" [attr.cy]="sy(p.mon)" r="4" class="evo-dot sc" />
            }
            <text [attr.x]="(W + P.l) / 2" [attr.y]="W - 4" text-anchor="middle" class="axis">Capilar (mg/dL)</text>
            <text x="10" [attr.y]="W / 2" text-anchor="middle" class="axis" [attr.transform]="'rotate(-90 10 ' + W / 2 + ')'">Monitor (mg/dL)</text>
          </svg>
          <p class="muted small">La línea discontinua es la coincidencia perfecta: por encima, el monitor marca de más; por debajo, de menos.</p>
        </section>

        <section class="card">
          <h3>Dónde se desvía</h3>
          <p class="muted small">Diferencia monitor − capilar (mediana ± intervalo del 95 %). Con menos de {{ minGroup }} pares no se saca conclusión.</p>
          <table class="lines evo-table">
            <caption class="sr-only">Diferencia por condiciones</caption>
            <thead><tr><th scope="col">Condición</th><th scope="col">Pares</th><th scope="col">Diferencia</th><th scope="col">Error medio</th></tr></thead>
            <tbody>
              @for (r of rows(c); track r.label) {
                <tr [class.faint]="!r.enough">
                  <th scope="row">{{ r.label }}</th>
                  <td>{{ r.n }}</td>
                  <td>
                    @if (r.enough) { {{ sgn(r.bias) }} @if (r.ci !== null) { <small class="muted">±{{ fmt(r.ci, 0) }}</small> } } @else { <small class="muted">pocos datos</small> }
                  </td>
                  <td>{{ r.enough ? fmt(r.mae, 0) : '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </section>

        @if (c.model.n > 0) {
          <section class="card">
            <h3>Contraste con el modelo predictivo</h3>
            <p>
              En {{ c.model.n }} pares el modelo (insulina, raciones y curva de acción) tenía una previsión para ese momento. Frente al capilar, el modelo se
              desvía <strong>{{ fmt(c.model.maeModelVsCap, 0) }} mg/dL</strong> de media y el monitor
              <strong>{{ fmt(c.model.maeMonVsCap, 0) }} mg/dL</strong>.
            </p>
            <p class="muted small">
              Se muestra solo para comparar. El modelo no se usa para corregir el monitor porque su error es
              {{ (c.model.maeModelVsCap ?? 0) > (c.model.maeMonVsCap ?? 0) ? 'mayor' : 'comparable' }} al del propio monitor.
            </p>
          </section>
        }

        <details class="chart-table card">
          <summary>Últimos pares</summary>
          <table class="lines evo-table">
            <caption class="sr-only">Últimos pares monitor–capilar</caption>
            <thead><tr><th scope="col">Día</th><th scope="col">Hora</th><th scope="col">Cap.</th><th scope="col">Mon.</th><th scope="col">Dif.</th><th scope="col">Sensor</th></tr></thead>
            <tbody>
              @for (p of recent(); track $index) {
                <tr>
                  <th scope="row">{{ p.date.slice(5) }}</th>
                  <td>{{ time(p.t) }}</td>
                  <td>{{ p.cap }}</td>
                  <td>{{ p.mon }}</td>
                  <td>{{ sgn(p.diff) }}</td>
                  <td>{{ p.sensorDay ?? '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </details>
      }

      <p class="muted small">
        Informativo: se aprende de tus propias mediciones y puede equivocarse. No sustituye al capilar, que es el valor de referencia, ni a la
        valoración del equipo médico. Nunca se oculta ni se modifica un aviso de hipoglucemia del monitor.
      </p>
    }
  `,
})
export class MonitorPanel {
  protected readonly calib = inject(CalibrationService);
  private readonly data = inject(DataService);

  protected readonly W = W;
  protected readonly P = P;
  protected readonly window = WINDOW_DAYS;
  protected readonly reliable = MIN_RELIABLE;
  protected readonly minBack = MIN_BACKTEST;
  protected readonly minGroup = MIN_GROUP;
  protected readonly gap = PAIR_MAX_GAP_MIN;
  protected readonly lo = 40;
  protected readonly today = todayStr();
  protected readonly fmt = fmtNum;
  protected readonly sgn = sgn;
  protected readonly abs = Math.abs;
  protected readonly time = fmtTime;

  protected readonly cal = this.calib.cal;
  protected readonly newSensor = signal(todayStr());
  protected readonly msg = signal('');

  protected readonly sensors = computed(() => [...(this.data.settings().sensors ?? [])].sort().reverse().slice(0, 12));
  protected readonly currentDay = computed(() => sensorDayOf(todayStr(), this.data.settings().sensors));

  constructor() {
    void this.calib.reload(); // la pestaña siempre enseña datos al día
  }

  protected progress(c: Calibration): number {
    return Math.min(100, (c.n / MIN_RELIABLE) * 100);
  }

  protected headline(c: Calibration): string {
    switch (c.status) {
      case 'recopilando':
        return `Recopilando datos: aún no hay suficientes pares para estimar nada (${c.n} de ${MIN_PAIRS}).`;
      case 'aprendiendo':
        return `Aprendiendo: ya hay una primera estimación, pero todavía no está comprobada. No se muestran avisos en las lecturas.`;
      case 'fiable':
        return `Validado: la corrección aprendida reduce el error del monitor un ${fmtNum((c.test.improvement ?? 0) * 100, 0)} % en comprobaciones con datos nuevos. Ya se muestran avisos en las lecturas.`;
      default:
        return `Sin diferencia predecible: con ${c.n} pares, corregir el monitor no mejora su error (${fmtNum(c.test.maeRaw, 0)} mg/dL de media). No se muestran avisos.`;
    }
  }

  protected rows(c: Calibration): GroupRow[] {
    return [...c.byZone, ...c.byArrow, ...c.byBand].filter((r) => r.n > 0);
  }

  protected recent() {
    return [...(this.cal()?.pairs ?? [])].reverse().slice(0, 20);
  }

  /* ---- gráfica ---- */
  protected readonly hi = computed(() => {
    const pairs = this.cal()?.pairs ?? [];
    const mx = Math.max(250, ...pairs.flatMap((p) => [p.cap, p.mon]));
    return Math.ceil((mx + 10) / 50) * 50;
  });
  protected readonly ticks = computed(() => {
    const out: number[] = [];
    for (let t = 50; t <= this.hi(); t += 50) out.push(t);
    return out;
  });
  protected sx(v: number): number {
    return P.l + ((v - this.lo) / (this.hi() - this.lo)) * (W - P.l - P.r);
  }
  protected sy(v: number): number {
    return W - P.b - ((v - this.lo) / (this.hi() - this.lo)) * (W - P.t - P.b);
  }

  /* ---- cambios de sensor ---- */
  protected addSensor(): void {
    const d = this.newSensor();
    this.msg.set('');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > todayStr()) {
      this.msg.set('Elige una fecha válida (no puede ser futura).');
      return;
    }
    const list = [...new Set([...(this.data.settings().sensors ?? []), d])].sort();
    this.saveSensors(list);
    this.msg.set(`Cambio de sensor anotado el ${d}.`);
  }

  protected removeSensor(d: string): void {
    if (!confirm(`¿Quitar el cambio de sensor del ${d}? Los pares de esos días dejarán de contar con su día de sensor.`)) return;
    this.saveSensors((this.data.settings().sensors ?? []).filter((x) => x !== d));
  }

  private saveSensors(list: string[]): void {
    this.data.settings.update((s) => ({ ...s, sensors: list }));
    void this.data.saveSettings(this.data.settings());
    this.calib.recompute();
  }
}
