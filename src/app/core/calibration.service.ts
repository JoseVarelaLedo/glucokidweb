import { Injectable, inject, signal } from '@angular/core';
import { Calibration, WINDOW_DAYS, attachPredictions, buildCalibration, collectPairs } from './calibration';
import { DataService } from './data.service';
import { DayRecord } from './models';
import { fitModel } from './model-fit';
import { ModelFit, NO_FIT, modelFit } from './predict';
import { addDays, todayStr } from './util';

/**
 * Mantiene en memoria la fiabilidad monitor–capilar calculada con los últimos WINDOW_DAYS días.
 * Se carga solo cuando hace falta (al abrir la pestaña «Monitor» o al mostrar una lectura del monitor) y como mucho
 * una vez por sesión, para no gastar lecturas de Firestore; la pestaña «Monitor» siempre la refresca.
 */
@Injectable({ providedIn: 'root' })
export class CalibrationService {
  private readonly data = inject(DataService);
  readonly cal = signal<Calibration | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  /** Registros de los últimos WINDOW_DAYS días tal y como se cargaron (los usan también los informes y la evaluación de la previsión). */
  readonly history = signal<DayRecord[]>([]);
  private get days(): DayRecord[] {
    return this.history();
  }
  /**
   * Ajuste del modelo predictivo con las curvas reales del sensor (ver `model-fit.ts`). Se recalcula solo al cambiar el historial o los Ajustes
   * y se publica en `modelFit`, que es lo que usa `analyzeDay`.
   */
  readonly fit = signal<ModelFit>(NO_FIT);
  private key = '';
  private inFlight?: Promise<void>;

  /** Carga una vez por sesión (y por niño). */
  ensure(): Promise<void> {
    if (this.key === this.data.viewUid() && this.cal()) return Promise.resolve();
    return this.reload();
  }

  reload(): Promise<void> {
    this.inFlight ??= this.doReload().finally(() => (this.inFlight = undefined));
    return this.inFlight;
  }

  private async doReload(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const today = todayStr();
      this.history.set(await this.data.getRange(addDays(today, -(WINDOW_DAYS - 1)), today));
      this.key = this.data.viewUid();
      this.recompute();
    } catch (e) {
      this.error.set('No se han podido cargar los registros. ' + (e instanceof Error ? e.message : ''));
    } finally {
      this.loading.set(false);
    }
  }

  /** Recalcula el ajuste con el historial ya cargado (también al cambiar el factor de sensibilidad o la ratio, que lo invalidan). */
  refit(): void {
    if (!this.history().length) {
      this.fit.set(NO_FIT);
      modelFit.set(NO_FIT);
      return;
    }
    const f = fitModel(this.history(), this.data.settings(), this.data.foods());
    this.fit.set(f);
    modelFit.set(f);
  }

  /** Vuelve a calcular con los días ya cargados (p. ej. tras anotar un cambio de sensor). */
  recompute(): void {
    this.refit(); // primero el ajuste: las predicciones de los pares ya lo usan
    const pairs = collectPairs(this.days, this.data.settings().sensors);
    attachPredictions(pairs, this.days, this.data.settings(), this.data.foods());
    this.cal.set(buildCalibration(pairs));
  }
}
