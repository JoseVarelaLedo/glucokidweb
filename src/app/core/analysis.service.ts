import { Injectable, computed, inject } from '@angular/core';
import { CalibrationService } from './calibration.service';
import { DataService } from './data.service';
import { BandModel, Evaluation, EvalRecord, buildBands, collectRecords, evaluate } from './predictor-eval';

/**
 * Análisis que necesitan varios paneles (bandas de la gráfica, informe) sobre los últimos 180 días ya cargados por
 * `CalibrationService`. Se calculan solo cuando alguien los lee y se recalculan si cambian los registros o los ajustes.
 * No lee nada nuevo de Firestore: `ensure()` reutiliza la carga única por sesión de la calibración.
 */
@Injectable({ providedIn: 'root' })
export class AnalysisService {
  private readonly calib = inject(CalibrationService);
  private readonly data = inject(DataService);

  /** Carga el historial si todavía no se ha cargado en esta sesión. */
  ensure(): Promise<void> {
    return this.calib.ensure();
  }

  readonly records = computed<EvalRecord[]>(() => {
    const days = this.calib.history();
    return days.length ? collectRecords(days, this.data.settings(), this.data.foods()) : [];
  });
  readonly evaluation = computed<Evaluation>(() => evaluate(this.records()));
  readonly bands = computed<BandModel>(() => buildBands(this.records()));
}
