import { Component, DoCheck, computed, inject, input, signal } from '@angular/core';
import { DataService } from '../core/data.service';
import { DayRecord } from '../core/models';
import { DayAnalysis, Level, PatternFinding, analyzeDay, analyzePatterns, fmtTime, mealCarbs } from '../core/predict';
import { addDays, canon, fmtNum } from '../core/util';
import { GlucoseChart } from './glucose-chart';

const LEVEL_ICON: Record<Level, string> = { alerta: '⚠', atencion: '!', info: 'i', ok: '✓' };
const CONF: Record<'alta' | 'media' | 'baja', string> = { alta: 'Fiabilidad alta', media: 'Fiabilidad media', baja: 'Fiabilidad baja' };

/**
 * Panel del final del día: curva de glucemia (medida + prevista), resumen,
 * desviaciones, recomendaciones por comida y patrones de los últimos días.
 * Todo es informativo: no cambia ninguna dosis.
 */
@Component({
  selector: 'app-day-curve',
  imports: [GlucoseChart],
  template: `
    <section class="card day-curve" aria-label="Curva de glucemia del día">
      <h3>Curva de glucemia</h3>
      <app-glucose-chart [analysis]="analysis()" />

      <dl class="summary tight">
        <div><dt>Insulina rápida</dt><dd>{{ fmt(totals().rapid) }} U</dd></div>
        <div><dt>Insulina lenta</dt><dd>{{ fmt(totals().lenta) }} U</dd></div>
        <div>
          <dt>Hidratos anotados</dt>
          <dd>
            {{ fmt(totals().carbs, 0) }} g
            @if (totals().carbs > 0) { · {{ fmt(totals().carbs / gpr(), 1) }} rac. }
          </dd>
        </div>
        @if (carbTarget(); as t) {
          <div><dt>Referencia diaria</dt><dd>≈ {{ fmt(t, 0) }} g</dd></div>
        }
      </dl>
      @if (totals().unknownFoods) {
        <p class="muted small">Algunos alimentos no se han podido contar (nombre fuera del catálogo o cantidad sin g/ml).</p>
      }

      @for (g of a().general; track $index) {
        <p class="rec info"><span class="rec-ic" aria-hidden="true">i</span> {{ g.text }}</p>
      }

      @for (e of a().episodes; track e.mealId) {
        @if (e.points.length > 1 || e.recs.length) {
          <article class="episode">
            <header>
              <strong>{{ e.name }}</strong>
              <span class="muted small">desde las {{ fmtT(e.t0) }} · {{ e.g0 }} mg/dL</span>
              @if (e.points.length > 1) {
                <span class="chip" [class.warn]="e.confidence !== 'alta'">{{ conf(e.confidence) }}</span>
              }
            </header>
            @if (e.points.length > 1) {
              <p class="muted small">
                Previsto: mínimo ≈ {{ fmt(e.nadir?.g, 0) }} mg/dL ({{ fmtT(e.nadir?.t ?? 0) }}) · máximo ≈ {{ fmt(e.peak?.g, 0) }} mg/dL ({{ fmtT(e.peak?.t ?? 0) }})
                @if (e.meanDev !== null) { · desviación media {{ e.meanDev > 0 ? '+' : '' }}{{ fmt(e.meanDev, 0) }} mg/dL }
              </p>
            }
            @for (r of e.recs; track $index) {
              <p class="rec" [class]="'rec ' + r.level"><span class="rec-ic" aria-hidden="true">{{ icon(r.level) }}</span> {{ r.text }}</p>
            }
          </article>
        }
      }

      <div class="patterns">
        <button type="button" class="btn ghost" [disabled]="loadingPat()" (click)="loadPatterns()">
          {{ loadingPat() ? 'Analizando…' : 'Buscar patrones en los últimos 14 días' }}
        </button>
        @if (patterns(); as p) {
          @for (f of p.findings; track $index) {
            <p class="rec" [class]="'rec ' + f.level"><span class="rec-ic" aria-hidden="true">{{ icon(f.level) }}</span> {{ f.text }}</p>
          }
          <p class="muted small">Basado en {{ p.daysUsed }} día(s) con mediciones tras las comidas.</p>
        }
      </div>

      <p class="disclaimer">
        La curva prevista es una estimación con un modelo sencillo (insulina rápida, hidratos y flecha del monitor). No tiene en cuenta
        ejercicio, estrés, enfermedad ni la insulina lenta, y no sustituye la pauta de vuestro equipo médico: no la uséis para decidir dosis.
      </p>
    </section>
  `,
})
export class DayCurve implements DoCheck {
  private readonly data = inject(DataService);
  readonly day = input.required<DayRecord>();

  protected readonly fmt = fmtNum;
  protected readonly fmtT = fmtTime;
  protected readonly icon = (l: Level) => LEVEL_ICON[l];
  protected readonly conf = (c: 'alta' | 'media' | 'baja') => CONF[c];

  protected readonly a = signal<DayAnalysis>({ measured: [], doses: [], episodes: [], general: [], ready: false });
  protected readonly analysis = computed(() => this.a());
  protected readonly patterns = signal<{ findings: PatternFinding[]; daysUsed: number } | null>(null);
  protected readonly loadingPat = signal(false);

  private snap = '';

  ngDoCheck(): void {
    // El día se edita "in situ": recalculamos cuando cambia su contenido o la configuración.
    const s = this.data.settings();
    const key = canon([this.day(), s.isf, s.model, s.gramsPerRation, s.unitsPerRation, s.targetGlucose, this.data.foods().length]);
    if (key === this.snap) return;
    this.snap = key;
    this.a.set(analyzeDay(this.day(), s, this.data.foods()));
  }

  protected gpr(): number {
    return this.data.settings().gramsPerRation || 10;
  }

  protected totals() {
    const d = this.day();
    const foods = this.data.foods();
    let rapid = 0;
    let lenta = 0;
    let carbs = 0;
    let unknownFoods = 0;
    for (const m of d.meals) {
      if (m.kind === 'lenta') lenta += m.before.units ?? 0;
      else {
        rapid += m.before.units ?? 0;
        const c = mealCarbs(m, foods);
        carbs += c.grams;
        unknownFoods += c.unknown.length;
      }
    }
    carbs += d.extras.reduce((acc, x) => acc + (x.extraRations ?? 0) * this.gpr(), 0);
    return { rapid, lenta, carbs, unknownFoods };
  }

  protected carbTarget(): number | null {
    const s = this.data.settings();
    if (!s.dailyCalories || s.dailyCalories <= 0 || !s.carbPercent) return null;
    return (s.dailyCalories * (s.carbPercent / 100)) / 4;
  }

  protected async loadPatterns(): Promise<void> {
    this.loadingPat.set(true);
    try {
      const to = this.day().date;
      const days = await this.data.getRange(addDays(to, -13), to);
      // el día actual puede tener cambios aún sin guardar: usamos la versión en pantalla
      const merged = [...days.filter((x) => x.date !== to), this.day()];
      this.patterns.set(analyzePatterns(merged, this.data.settings(), this.data.foods()));
    } finally {
      this.loadingPat.set(false);
    }
  }
}
