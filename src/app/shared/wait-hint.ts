import { Component, DoCheck, computed, inject, input, signal } from '@angular/core';
import { AnalysisService } from '../core/analysis.service';
import { CalibrationService } from '../core/calibration.service';
import { DataService } from '../core/data.service';
import { adviseWait, waitGate, waitStats } from '../core/meal-wait';
import { DayRecord, Meal } from '../core/models';
import { canon, todayStr } from '../core/util';

interface View {
  kind: 'advice' | 'note';
  head?: string;
  detail?: string;
  evidence?: string | null;
  text?: string;
}

/**
 * Debajo del campo «Hora a la que va a comer»: sugerencia, solo informativa, de cuándo empezar a comer tras inyectar (ver `core/meal-wait.ts`).
 * Aparece en el día de hoy cuando la comida tiene hora, glucemia y dosis de rápida y todavía no se ha anotado la hora de comer.
 */
@Component({
  selector: 'app-wait-hint',
  template: `
    @if (v(); as x) {
      @if (x.kind === 'advice') {
        <div class="wait-hint" role="note" aria-label="Hora recomendada para empezar a comer">
          <p class="rec info"><span class="rec-ic" aria-hidden="true">i</span> <strong>{{ x.head }}</strong></p>
          <p class="muted small">{{ x.detail }}</p>
          @if (x.evidence) {
            <p class="muted small">{{ x.evidence }}</p>
          }
          <p class="muted small">Es solo informativo: no cambia ninguna dosis ni sustituye la pauta de vuestro equipo médico.</p>
        </div>
      } @else {
        <p class="muted small" role="note">{{ x.text }}</p>
      }
    }
  `,
})
export class WaitHint implements DoCheck {
  private readonly data = inject(DataService);
  private readonly calib = inject(CalibrationService);
  private readonly analysis = inject(AnalysisService);

  readonly day = input.required<DayRecord>();
  readonly meal = input.required<Meal>();

  protected readonly v = signal<View | null>(null);
  /** Espera habitual y contraste con el historial: solo cambian al cargar el historial. */
  private readonly stats = computed(() => waitStats(this.calib.history()));
  private snap = '';
  private ensured = '';

  ngDoCheck(): void {
    const d = this.day();
    const m = this.meal();
    const visible =
      m.kind === 'rapida' && d.date === todayStr() && !m.foodTime && (m.before.units ?? 0) > 0 && !!m.before.time && m.before.value !== null && m.before.value !== undefined;
    if (!visible) {
      if (this.v()) this.v.set(null);
      this.snap = '';
      return;
    }
    const uid = this.data.viewUid();
    if (this.ensured !== uid) {
      this.ensured = uid;
      void this.calib.ensure(); // historial: de él salen el ajuste del modelo y la espera habitual
      void this.analysis.ensure(); // y la evaluación de la previsión (fiabilidad)
    }
    const s = this.data.settings();
    const fit = this.calib.fit();
    const bands = this.analysis.bands();
    const key = canon([d.date, d.meals, d.extras, s.isf, s.gramsPerRation, s.unitsPerRation, s.model, s.injections, this.data.foods().length, fit, bands?.ready, bands?.wide, bands?.have, this.stats()]);
    if (key === this.snap) return;
    this.snap = key;

    const gate = waitGate(fit, bands);
    if (!gate.ok) {
      this.v.set({ kind: 'note', text: `Sugerencia de hora para empezar a comer: todavía se está aprendiendo (${gate.why}).` });
      return;
    }
    const a = adviseWait(d, m, s, this.data.foods(), fit, this.stats());
    this.v.set(a.ok ? { kind: 'advice', head: a.head, detail: a.detail, evidence: a.evidence } : { kind: 'note', text: `No se sugiere hora para empezar a comer: ${a.reason}.` });
  }
}
