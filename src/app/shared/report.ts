import { Component, computed, inject, signal } from '@angular/core';
import { AnalysisService } from '../core/analysis.service';
import { HYPO_PARTS, buildReport, lastSensorDate } from '../core/agp';
import { AuthService } from '../core/auth.service';
import { CalibrationService } from '../core/calibration.service';
import { DataService } from '../core/data.service';
import { analyzeNights } from '../core/overnight';
import { Metric } from '../core/predictor-eval';
import { fmtTime } from '../core/predict';
import { addDays, fmtNum, todayStr } from '../core/util';
import { GlucoseProfile } from './glucose-profile';

type Sub = 'resumen' | 'noche' | 'prevision';

const dmy = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Informe para llevar a la consulta: tiempo en rango, media, GMI, variabilidad, perfil por horas, noches y ayunas, y cuánto se parece
 * la previsión a lo medido. Todo sale de la serie continua del sensor (CSV importado) y es informativo: no cambia ninguna dosis ni
 * ningún cálculo, y no sustituye la valoración del equipo médico. «Imprimir» permite guardarlo como PDF.
 */
@Component({
  selector: 'app-report',
  imports: [GlucoseProfile],
  template: `
    <section class="card report" aria-label="Informe para la consulta">
      <h3>Informe para la consulta</h3>
      <p class="print-only rep-print-head">
        {{ childName() }} · informe generado el {{ dmy(today) }}
        @if (to(); as t) { · datos del sensor hasta el {{ dmy(t) }} }
      </p>

      <div class="rep-controls no-print">
        <div class="rep-periods" role="group" aria-label="Periodo del informe">
          @for (p of periods; track p) {
            <button type="button" class="chip-btn" [class.on]="days() === p" [attr.aria-pressed]="days() === p" (click)="days.set(p)">{{ p }} días</button>
          }
        </div>
        <div class="row gap">
          <button type="button" class="btn small ghost" [disabled]="calib.loading()" (click)="refresh()">{{ calib.loading() ? 'Cargando…' : 'Actualizar datos' }}</button>
          <button type="button" class="btn small primary" [disabled]="!rep().summary" (click)="print()">Imprimir / guardar PDF</button>
        </div>
      </div>
      <p class="muted small no-print">
        Se calcula con los últimos 180 días guardados, cargados una vez por sesión: si acabas de importar o corregir algo, pulsa «Actualizar datos».
      </p>

      @if (calib.error()) {
        <p class="error" role="alert">{{ calib.error() }}</p>
      }

      <div class="view-sub no-print" role="tablist" aria-label="Apartados del informe">
        @for (s of subs; track s.key) {
          <button type="button" role="tab" [attr.aria-selected]="sub() === s.key" [class.on]="sub() === s.key" (click)="sub.set(s.key)">{{ s.label }}</button>
        }
      </div>
    </section>

    @if (calib.loading() && !hasHistory()) {
      <p class="muted" role="status">Cargando los registros…</p>
    } @else {
      <!-- ============================ RESUMEN ============================ -->
      <section class="card rep-sec" [class.on]="sub() === 'resumen'" aria-label="Resumen de glucosa">
        <h4>Resumen de glucosa</h4>
        @if (rep(); as r) {
          @if (!r.summary) {
            <p class="muted">{{ r.notes[0] }}</p>
          } @else {
            @let s = r.summary;
            <p class="muted small">
              Del {{ dmy(s.from) }} al {{ dmy(s.to) }} · {{ s.daysWithData }} de {{ s.nDays }} días con datos ·
              {{ fmt(s.readings, 0) }} lecturas del sensor · datos del {{ fmt(s.coverage * 100, 0) }} % del periodo.
            </p>
            @for (n of r.notes; track $index) {
              <p class="rec atencion"><span class="rec-ic" aria-hidden="true">!</span> {{ n }}</p>
            }

            <dl class="summary tight rep-tiles">
              <div><dt>Glucosa media</dt><dd>{{ fmt(s.mean, 0) }} mg/dL</dd></div>
              <div><dt>GMI (A1c estimada)</dt><dd>{{ fmt(s.gmi, 1) }} %</dd></div>
              <div><dt>Variabilidad (CV)</dt><dd>{{ fmt(s.cv, 0) }} %</dd></div>
              <div><dt>Desviación típica</dt><dd>{{ fmt(s.sd, 0) }} mg/dL</dd></div>
              <div><dt>Mínimo · máximo</dt><dd>{{ s.min }} · {{ s.max }}</dd></div>
            </dl>

            <h5>Tiempo en cada tramo</h5>
            <div class="tir-bar" role="img" [attr.aria-label]="tirLabel()">
              <span class="seg vlow" [style.flex-grow]="s.tir.vlow" [title]="'Menos de 54: ' + fmt(s.tir.vlow, 1) + ' %'"></span>
              <span class="seg low" [style.flex-grow]="s.tir.low" [title]="'54–69: ' + fmt(s.tir.low, 1) + ' %'"></span>
              <span class="seg range" [style.flex-grow]="s.tir.range" [title]="'70–180: ' + fmt(s.tir.range, 1) + ' %'"></span>
              <span class="seg high" [style.flex-grow]="s.tir.high" [title]="'181–250: ' + fmt(s.tir.high, 1) + ' %'"></span>
              <span class="seg vhigh" [style.flex-grow]="s.tir.vhigh" [title]="'Más de 250: ' + fmt(s.tir.vhigh, 1) + ' %'"></span>
            </div>
            <p class="tir-key small muted">
              <span><i class="k vlow"></i> &lt; 54</span><span><i class="k low"></i> 54–69</span><span><i class="k range"></i> 70–180</span>
              <span><i class="k high"></i> 181–250</span><span><i class="k vhigh"></i> &gt; 250</span>
            </p>
            <table class="lines rep-table">
              <caption class="sr-only">Tiempo en rango frente a los objetivos del consenso internacional</caption>
              <thead><tr><th scope="col">Tramo</th><th scope="col">Tiempo</th><th scope="col">Objetivo</th><th scope="col">Estado</th></tr></thead>
              <tbody>
                @for (t of r.targets; track t.key) {
                  <tr>
                    <th scope="row">{{ t.label }}</th><td>{{ t.value }}</td><td>{{ t.goal }}</td>
                    <td [class.t-ok]="t.ok" [class.t-out]="t.ok === false">{{ t.ok ? 'Dentro' : 'Fuera' }}</td>
                  </tr>
                }
              </tbody>
            </table>
            <p class="muted small">
              Objetivos generales del consenso internacional sobre monitorización continua. Los objetivos de cada niño los marca su equipo médico.
            </p>

            @if (r.hypos; as h) {
              <h5>Hipoglucemias (al menos 15 min por debajo de 70)</h5>
              @if (!h.events) {
                <p>No hay episodios en este periodo.</p>
              } @else {
                <p>
                  <strong>{{ h.events }}</strong> {{ h.events === 1 ? 'episodio' : 'episodios' }}
                  @if (h.severe) { ({{ h.severe }} por debajo de 54) }
                  · duración media {{ fmt(h.meanMin, 0) }} min · el más largo {{ fmt(h.longest, 0) }} min.
                </p>
                <ul class="sensor-facts">
                  @for (p of hypoParts; track p; let i = $index) {
                    @if (h.byPart[i]) { <li>{{ p }}: {{ h.byPart[i] }}</li> }
                  }
                </ul>
              }
            }

            <h5>Perfil por horas del día</h5>
            <p class="muted small">Todos los días del periodo superpuestos: la línea es la mediana y la franja oscura, donde estuvo la mitad de las lecturas.</p>
            <app-glucose-profile [bins]="r.agp" label="Perfil ambulatorio de glucosa: mediana y franjas por hora del día" />

            @if (r.weeks.length) {
              <h5>Por semanas</h5>
              <table class="lines rep-table">
                <caption class="sr-only">Comparación por semanas</caption>
                <thead><tr><th scope="col">Semana</th><th scope="col">Media</th><th scope="col">En rango</th><th scope="col">&lt; 70</th><th scope="col">&gt; 180</th><th scope="col">CV</th><th scope="col">Datos</th></tr></thead>
                <tbody>
                  @for (w of r.weeks; track w.from) {
                    <tr>
                      <th scope="row">{{ dmy(w.from).slice(0, 5) }}–{{ dmy(w.to).slice(0, 5) }}</th>
                      @if (w.summary; as ws) {
                        <td>{{ fmt(ws.mean, 0) }}</td><td>{{ fmt(ws.tir.range, 0) }} %</td><td>{{ fmt(ws.tir.below, 1) }} %</td><td>{{ fmt(ws.tir.above, 0) }} %</td><td>{{ fmt(ws.cv, 0) }} %</td>
                        <td>{{ fmt(ws.coverage * 100, 0) }} %</td>
                      } @else {
                        <td colspan="6" class="muted">sin datos</td>
                      }
                    </tr>
                  }
                </tbody>
              </table>
            }
          }
        }
      </section>

      <!-- ====================== NOCHE Y AYUNAS ====================== -->
      <section class="card rep-sec" [class.on]="sub() === 'noche'" aria-label="Noche y ayunas">
        <h4>Noche y ayunas</h4>
        @if (night(); as o) {
          <p class="muted small">
            Se miran las noches sin comida ni insulina rápida activa (entre las 00:00 y las 06:00, o hasta la primera comida o dosis del día), descontando lo que aún pudiera
            quedar de la cena o de la última rápida de la tarde anterior. Son observaciones para comentar con el equipo médico: no indican qué dosis cambiar.
          </p>
          @for (f of o.findings; track $index) {
            <p class="rec" [class]="'rec ' + f.level"><span class="rec-ic" aria-hidden="true">{{ f.level === 'info' ? 'i' : f.level === 'alerta' ? '⚠' : '!' }}</span> {{ f.text }}</p>
          }
          @if (o.nights.length) {
            <dl class="summary tight rep-tiles">
              <div><dt>Noches valoradas</dt><dd>{{ o.nights.length }}</dd></div>
              <div><dt>Suben · bajan · estables</dt><dd>{{ o.rising }} · {{ o.falling }} · {{ o.stable }}</dd></div>
              <div><dt>Noches con hipoglucemia</dt><dd>{{ o.hypoNights }}</dd></div>
              <div><dt>Cambio mediano</dt><dd>{{ o.medianChange === null ? '–' : (o.medianChange > 0 ? '+' : '') + fmt(o.medianChange, 0) }} mg/dL</dd></div>
              @if (o.fasting; as f) {
                <div><dt>Ayunas (mediana)</dt><dd>{{ fmt(f.median, 0) }} mg/dL</dd></div>
              }
            </dl>
            <h5>Perfil de las noches valoradas</h5>
            <app-glucose-profile [bins]="o.profile" [from]="0" [to]="360" label="Perfil nocturno de glucosa de las noches valoradas" />
            <details class="chart-table">
              <summary>Ver noche por noche ({{ o.nights.length }})</summary>
              <table class="lines rep-table">
                <caption class="sr-only">Noches valoradas</caption>
                <thead><tr><th scope="col">Noche</th><th scope="col">Ventana</th><th scope="col">Inicio → final</th><th scope="col">Mín.</th><th scope="col">Máx.</th><th scope="col">&lt; 70</th><th scope="col">Ayunas</th></tr></thead>
                <tbody>
                  @for (n of o.nights; track n.date) {
                    <tr>
                      <th scope="row">{{ dmy(n.date).slice(0, 5) }}</th>
                      <td>{{ fmtT(n.start) }}–{{ fmtT(n.end) }}</td>
                      <td>{{ fmt(n.startG, 0) }} → {{ fmt(n.endG, 0) }}</td>
                      <td>{{ n.min }}</td><td>{{ n.max }}</td>
                      <td>{{ n.hypo ? 'Sí' : 'No' }}</td>
                      <td>{{ n.fasting === null ? '–' : fmt(n.fasting, 0) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </details>
          }
          @if (o.skipped.length) {
            <details class="chart-table">
              <summary>Noches no valoradas ({{ o.skipped.length }})</summary>
              <ul class="sensor-facts">
                @for (k of o.skipped; track k.date) { <li>{{ dmy(k.date).slice(0, 5) }}: {{ k.reason }}</li> }
              </ul>
            </details>
          }
        }
      </section>

      <!-- ====================== PRECISIÓN DE LA PREVISIÓN ====================== -->
      <section class="card rep-sec" [class.on]="sub() === 'prevision'" aria-label="Precisión de la previsión">
        <h4>Precisión de la previsión</h4>
        @if (ev(); as e) {
          <p class="muted small">
            Compara la curva prevista de cada comida con lo que midió después el sensor (o, si ese día no hay serie, las mediciones anotadas). Solo es una observación:
            no cambia la previsión ni la calculadora de dosis. Se usan los ajustes actuales y lo que se anotó de hidratos y dosis.
          </p>
          @for (n of e.notes; track $index) {
            <p class="rec info"><span class="rec-ic" aria-hidden="true">i</span> {{ n }}</p>
          }
          @if (e.records) {
            <p class="muted small">
              {{ e.meals }} {{ e.meals === 1 ? 'comida' : 'comidas' }} de {{ e.days }} {{ e.days === 1 ? 'día' : 'días' }} · {{ fmt(e.records, 0) }} comparaciones ·
              {{ fmt(e.sensorShare * 100, 0) }} % con el sensor continuo.
            </p>
            <table class="lines rep-table">
              <caption class="sr-only">Error de la previsión según el tiempo desde la comida</caption>
              <thead>
                <tr><th scope="col">A las…</th><th scope="col">Comparaciones</th><th scope="col">Error medio</th><th scope="col">Real − previsto</th><th scope="col">A ≤ 30 mg/dL</th><th scope="col">Mejora a «sigue igual»</th></tr>
              </thead>
              <tbody>
                @for (h of e.horizons; track h.minutes) {
                  <tr>
                    <th scope="row">{{ h.minutes / 60 }} h</th>
                    @if (h.m; as m) {
                      <td>{{ m.n }}</td><td>{{ fmt(m.mae, 0) }} mg/dL</td><td>{{ m.bias > 0 ? '+' : '' }}{{ fmt(m.bias, 0) }}</td><td>{{ fmt(m.near * 100, 0) }} %</td>
                      <td>{{ m.skill === null ? '–' : fmt(m.skill * 100, 0) + ' %' }}</td>
                    } @else {
                      <td colspan="5" class="muted">sin datos</td>
                    }
                  </tr>
                }
              </tbody>
            </table>

            @if (e.byMeal.length) {
              <h5>Por comida (error medio · comparaciones)</h5>
              <table class="lines rep-table">
                <caption class="sr-only">Error de la previsión por comida</caption>
                <thead><tr><th scope="col">Comida</th>@for (h of e.horizons; track h.minutes) { <th scope="col">{{ h.minutes / 60 }} h</th> }</tr></thead>
                <tbody>
                  @for (g of e.byMeal; track g.label) {
                    <tr><th scope="row">{{ g.label }}</th>@for (c of g.cells; track $index) { <td>{{ cell(c) }}</td> }</tr>
                  }
                </tbody>
              </table>
            }
            @if (e.byPart.length) {
              <h5>Por hora del día (error medio · comparaciones)</h5>
              <table class="lines rep-table">
                <caption class="sr-only">Error de la previsión según la hora de la comida</caption>
                <thead><tr><th scope="col">Comida entre…</th>@for (h of e.horizons; track h.minutes) { <th scope="col">{{ h.minutes / 60 }} h</th> }</tr></thead>
                <tbody>
                  @for (g of e.byPart; track g.label) {
                    <tr><th scope="row">{{ g.label }}</th>@for (c of g.cells; track $index) { <td>{{ cell(c) }}</td> }</tr>
                  }
                </tbody>
              </table>
            }
          }
        }
        @if (bands(); as b) {
          <h5>Banda de incertidumbre</h5>
          @if (!b.ready) {
            <p>Aún no hay banda: hay {{ b.have }} comparaciones a las 2 h y hacen falta {{ b.needed }}.</p>
          } @else {
            <p>
              A las 2 h de la comida, el 80 % de los casos reales cayó en un margen de <strong>{{ fmt(b.width120, 0) }} mg/dL</strong> alrededor de la curva prevista
              ({{ b.have }} comparaciones).
              @if (b.wide) { <strong>La previsión es poco informativa: es mejor mirarla solo como una idea general.</strong> }
            </p>
            @if (b.coverage; as c) {
              <p class="muted small">
                Comprobación hacia delante: con la banda calculada solo con días anteriores, lo real cayó dentro el {{ fmt(c.rate * 100, 0) }} % de las {{ fmt(c.n, 0) }} veces (lo ideal es cerca del 80 %).
              </p>
            }
          }
        }
      </section>

      <p class="muted small rep-disclaimer">
        GlucoKid no es un producto sanitario. Este informe es una ayuda para ordenar los datos y llevarlos a la consulta; las decisiones sobre dosis y objetivos
        las toma el equipo médico.
      </p>
    }
  `,
})
export class ReportPanel {
  protected readonly calib = inject(CalibrationService);
  private readonly analysis = inject(AnalysisService);
  private readonly data = inject(DataService);
  private readonly auth = inject(AuthService);

  protected readonly today = todayStr();
  protected readonly periods = [7, 14, 30, 90] as const;
  protected readonly days = signal<number>(14);
  protected readonly sub = signal<Sub>('resumen');
  protected readonly subs: ReadonlyArray<{ key: Sub; label: string }> = [
    { key: 'resumen', label: 'Resumen' },
    { key: 'noche', label: 'Noche y ayunas' },
    { key: 'prevision', label: 'Previsión' },
  ];
  protected readonly fmt = fmtNum;
  protected readonly fmtT = fmtTime;
  protected readonly dmy = dmy;
  protected readonly hypoParts = HYPO_PARTS;

  protected readonly hasHistory = computed(() => this.calib.history().length > 0);
  protected readonly childName = computed(() => this.auth.childName(this.data.viewUid()));
  /** Último día con lecturas del sensor: el informe termina ahí (no en «hoy», que puede estar sin importar). */
  protected readonly to = computed(() => lastSensorDate(this.calib.history()));
  private readonly end = computed(() => this.to() ?? this.today);

  protected readonly rep = computed(() => buildReport(this.calib.history(), this.end(), this.days()));
  protected readonly night = computed(() => {
    const h = this.calib.history();
    return h.length ? analyzeNights(h, addDays(this.end(), -(this.days() - 1)), this.end(), this.data.settings(), this.data.foods()) : null;
  });
  protected readonly ev = computed(() => this.analysis.evaluation());
  protected readonly bands = computed(() => this.analysis.bands());

  constructor() {
    void this.analysis.ensure();
  }

  protected refresh(): void {
    void this.calib.reload();
  }

  protected print(): void {
    window.print();
  }

  protected tirLabel(): string {
    const s = this.rep().summary;
    return s
      ? `Tiempo por debajo de 54: ${fmtNum(s.tir.vlow, 1)} %; entre 54 y 69: ${fmtNum(s.tir.low, 1)} %; en rango 70 a 180: ${fmtNum(s.tir.range, 1)} %; entre 181 y 250: ${fmtNum(s.tir.high, 1)} %; por encima de 250: ${fmtNum(s.tir.vhigh, 1)} %`
      : '';
  }

  protected cell(m: Metric | null): string {
    if (!m) return '–';
    return m.enough ? `${Math.round(m.mae)} mg/dL · ${m.n}` : `pocos datos (${m.n})`;
  }
}
