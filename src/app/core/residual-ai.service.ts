import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { CalibrationService } from './calibration.service';
import { DataService } from './data.service';
import { Dataset, Readiness, TrainResult, buildDataset, readiness, trainResidual } from './residual-ai';
import { residualHook } from './predict';

export type AiStatus = 'off' | 'waiting' | 'loading' | 'training' | 'active' | 'rejected' | 'error';

const KEY_ON = 'glucokid.ai.enabled.';
const KEY_NOTE = 'glucokid.ai.dismissed.';

const read = (k: string): boolean => {
  try {
    return localStorage.getItem(k) === '1';
  } catch {
    return false;
  }
};
const write = (k: string, v: boolean): void => {
  try {
    localStorage.setItem(k, v ? '1' : '0');
  } catch {
    /* sin almacenamiento (ventana privada…): el interruptor funciona en esta sesión */
  }
};

/**
 * Corrección aprendida con TensorFlow.js (ver `residual-ai.ts`): interruptor, comprobación de que hay datos suficientes,
 * entrenamiento en el dispositivo y aviso cuando se puede activar. Desactivada por defecto.
 * El interruptor se guarda en este dispositivo y para cada niño (porque el entrenamiento también ocurre aquí).
 */
@Injectable({ providedIn: 'root' })
export class ResidualAiService {
  private readonly data = inject(DataService);
  private readonly calib = inject(CalibrationService);

  readonly enabled = signal(false);
  private readonly dismissed = signal(false);
  readonly status = signal<AiStatus>('off');
  readonly message = signal('');
  readonly result = signal<Pick<TrainResult, 'useful' | 'samples' | 'episodes' | 'valBase' | 'valModel'> | null>(null);
  /** Sube cada vez que cambia la corrección activa (para que la curva se recalcule). */
  readonly version = signal(0);

  /** Muestras previsto-real del historial cargado (solo se calcula cuando ya hay historial). */
  private readonly dataset = computed<Dataset | null>(() => {
    const fit = this.calib.fit();
    const h = this.calib.history();
    if (!h.length) return null;
    return buildDataset(h, this.data.settings(), this.data.foods(), fit);
  });
  readonly readiness = computed<Readiness | null>(() => {
    const d = this.dataset();
    return d ? readiness(d) : null;
  });
  /** Hay datos suficientes y la corrección está desactivada: se avisa (una vez, hasta que se descarte). */
  readonly notice = computed(() => !this.enabled() && !this.dismissed() && !!this.readiness()?.ready);
  readonly active = computed(() => this.status() === 'active');

  private current: TrainResult | null = null;
  private trained = '';
  private busy = false;

  constructor() {
    // las preferencias son por niño y por dispositivo
    effect(() => {
      const uid = this.data.viewUid();
      untracked(() => {
        this.enabled.set(read(KEY_ON + uid));
        this.dismissed.set(read(KEY_NOTE + uid));
        this.trained = '';
        if (!this.enabled()) this.stop();
      });
    });
    // al estar activada y haber datos suficientes se entrena (una vez por conjunto de datos)
    effect(() => {
      const on = this.enabled();
      const rd = this.readiness();
      const ds = this.dataset();
      untracked(() => {
        if (!on) return;
        if (!rd || !ds) {
          this.status.set('waiting');
          this.message.set('Esperando a cargar el historial…');
        } else if (!rd.ready) {
          this.stop();
          this.status.set('waiting');
          this.message.set('Todavía no hay datos suficientes: ' + rd.missing.join('; ') + '.');
        } else {
          void this.train(ds);
        }
      });
    });
  }

  setEnabled(on: boolean): void {
    write(KEY_ON + this.data.viewUid(), on);
    this.enabled.set(on);
    if (on) {
      void this.calib.ensure(); // necesita el historial
      this.dismiss(); // ya no hace falta el aviso
    } else this.stop();
  }

  dismiss(): void {
    write(KEY_NOTE + this.data.viewUid(), true);
    this.dismissed.set(true);
  }

  private stop(): void {
    this.current?.dispose();
    this.current = null;
    this.trained = '';
    residualHook.set(null);
    this.result.set(null);
    this.status.set('off');
    this.message.set('');
    this.version.update((n) => n + 1);
  }

  private async train(ds: Dataset): Promise<void> {
    const sig = `${this.data.viewUid()}|${ds.episodes}|${ds.samples.length}`;
    if (this.busy || sig === this.trained) return;
    this.busy = true;
    try {
      this.status.set('loading');
      this.message.set('Cargando TensorFlow.js…');
      const res = await trainResidual(ds, (m) => {
        this.status.set('training');
        this.message.set(m);
      });
      this.current?.dispose();
      this.current = res;
      this.trained = sig;
      this.result.set({ useful: res.useful, samples: res.samples, episodes: res.episodes, valBase: res.valBase, valModel: res.valModel });
      residualHook.set(res.useful ? res.hook : null);
      this.status.set(res.useful ? 'active' : 'rejected');
      this.message.set(
        res.useful
          ? `Activa: en las comidas más recientes (que no vio al entrenar) el error medio bajó de ${Math.round(res.valBase)} a ${Math.round(res.valModel)} mg/dL.`
          : `No se aplica: en las comidas más recientes no mejora al modelo base lo suficiente (${Math.round(res.valBase)} → ${Math.round(res.valModel)} mg/dL). Se volverá a probar cuando haya más datos.`,
      );
      this.version.update((n) => n + 1);
    } catch (e) {
      this.status.set('error');
      this.message.set('No se ha podido usar TensorFlow.js (¿está instalado el paquete y hay conexión?). ' + (e instanceof Error ? e.message : ''));
      this.trained = sig; // no reintentar en bucle
    } finally {
      this.busy = false;
    }
  }
}
