import { Injectable, inject, signal } from '@angular/core';
import { Calibration, WINDOW_DAYS, attachPredictions, buildCalibration, collectPairs } from './calibration';
import { DataService } from './data.service';
import { DayRecord } from './models';
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

  private days: DayRecord[] = [];
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
      this.days = await this.data.getRange(addDays(today, -(WINDOW_DAYS - 1)), today);
      this.key = this.data.viewUid();
      this.recompute();
    } catch (e) {
      this.error.set('No se han podido cargar los registros. ' + (e instanceof Error ? e.message : ''));
    } finally {
      this.loading.set(false);
    }
  }

  /** Vuelve a calcular con los días ya cargados (p. ej. tras anotar un cambio de sensor). */
  recompute(): void {
    const pairs = collectPairs(this.days, this.data.settings().sensors);
    attachPredictions(pairs, this.days, this.data.settings(), this.data.foods());
    this.cal.set(buildCalibration(pairs));
  }
}
