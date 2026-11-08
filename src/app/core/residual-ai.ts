/**
 * Corrección aprendida con TensorFlow.js (OPCIONAL, desactivada por defecto).
 *
 * Qué hace: una red neuronal muy pequeña aprende el ERROR que sigue cometiendo el modelo fisiológico (con su ajuste por franjas) respecto al sensor
 * del propio niño, y lo suma a la curva prevista. No sustituye al modelo, no toca Ajustes ni la calculadora, y su efecto está limitado a ±MAX_CORR mg/dL.
 *
 * Cómo se protege:
 *  - Solo se ofrece cuando hay datos suficientes (ver `readiness`).
 *  - Se entrena en el dispositivo (los datos no salen de él) y se valida con las comidas MÁS RECIENTES, que no ha visto al entrenar.
 *    Solo se usa si en esa validación mejora al modelo base al menos un `AI_MIN_GAIN`; si no, queda en «no mejora» y no se aplica.
 *  - TensorFlow.js se descarga solo cuando se activa (carga diferida), para no cargar la aplicación.
 * Es informativo: no sustituye al sensor, a la medición ni al equipo médico.
 */
import type * as TFNS from '@tensorflow/tfjs';
import { DayRecord, Food, Settings } from './models';
import { ModelFit, ResidualCtx, ResidualHook, SLOTS, Slot, analyzeDay, sensorPoints, slotOf } from './predict';

export const MAX_CORR = 40; // mg/dL: tope de lo que la red puede mover la curva
export const AI_MIN_EPISODES = 45;
export const AI_MIN_DAYS = 14;
export const AI_MIN_SAMPLES = 450;
export const AI_SLOT_MIN = 12; // comidas por franja para contarla
export const AI_MIN_SLOTS = 2;
export const AI_MIN_BASE_RMSE = 12; // si el modelo ya acierta mejor que esto, no hay nada que aprender
export const AI_MIN_GAIN = 0.05;
const GRID_FIRST = 20;
const GRID_STEP = 20;
const NEAR = 7;
export const N_FEATURES = 10;

export interface Sample {
  ep: string;
  date: string;
  x: number[];
  y: number; // sensor − previsión del modelo (mg/dL)
}

export interface Dataset {
  samples: Sample[];
  episodes: number;
  days: number;
  bySlot: Record<Slot, number>;
  baseRmse: number;
}

/** Variables de entrada de la red para un instante `h` (min desde el inicio) con previsión base `delta` (mg/dL sobre la glucemia inicial). */
export function features(c: ResidualCtx, h: number, delta: number): number[] {
  const a = (2 * Math.PI * c.hour) / 24;
  return [h / 300, c.g0 / 200, c.rate / 2.5, Math.sin(a), Math.cos(a), c.carbG / 100, c.units / 10, c.iob / 5, delta / 100, c.fat ? 1 : 0];
}

function nearest(pts: Array<{ t: number; g: number }>, t: number): number | null {
  let best: number | null = null;
  let bd = NEAR + 0.001;
  for (const p of pts) {
    const d = Math.abs(p.t - t);
    if (d < bd) {
      bd = d;
      best = p.g;
    }
  }
  return best;
}

/** Muestras (previsión del modelo vs sensor) de todas las comidas con curva continua completa, sin ejercicio ni datos dudosos. */
export function buildDataset(days: DayRecord[], s: Settings, foods: Food[], fit: ModelFit): Dataset {
  const samples: Sample[] = [];
  const dates = new Set<string>();
  const eps = new Set<string>();
  const slotEps: Record<Slot, Set<string>> = { manana: new Set(), mediodia: new Set(), noche: new Set() };
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of sorted) {
    const sp = sensorPoints(day.sensor);
    if (sp.length < 20) continue;
    const an = analyzeDay(day, s, foods, fit, null);
    for (const ep of an.episodes) {
      if (ep.points.length < 4 || !ep.ctx || ep.nowT !== undefined || ep.confidence === 'baja') continue;
      if (ep.recs.some((r) => r.code === 'ejercicio' || r.code === 'sin-dosis')) continue;
      const id = `${day.date}|${ep.mealId}`;
      let used = 0;
      for (const p of ep.points) {
        const h = p.t - ep.t0;
        if (h < GRID_FIRST || (h - GRID_FIRST) % GRID_STEP !== 0) continue;
        const gs = nearest(sp, p.t);
        if (gs === null) continue;
        samples.push({ ep: id, date: day.date, x: features(ep.ctx, h, p.g - ep.g0), y: gs - p.g });
        used++;
      }
      if (used >= 3) {
        eps.add(id);
        dates.add(day.date);
        slotEps[slotOf(ep.t0)].add(id);
      } else samples.length -= used;
    }
  }
  const baseRmse = samples.length ? Math.sqrt(samples.reduce((a, x) => a + x.y * x.y, 0) / samples.length) : 0;
  return {
    samples,
    episodes: eps.size,
    days: dates.size,
    bySlot: { manana: slotEps.manana.size, mediodia: slotEps.mediodia.size, noche: slotEps.noche.size },
    baseRmse,
  };
}

export interface Readiness {
  ready: boolean;
  episodes: number;
  days: number;
  samples: number;
  baseRmse: number;
  /** Lo que aún falta, en palabras. */
  missing: string[];
}

export function readiness(ds: Dataset): Readiness {
  const missing: string[] = [];
  const slotsOk = SLOTS.filter((x) => ds.bySlot[x.id] >= AI_SLOT_MIN).length;
  if (ds.episodes < AI_MIN_EPISODES) missing.push(`comidas con curva del sensor: ${ds.episodes} de ${AI_MIN_EPISODES}`);
  if (ds.days < AI_MIN_DAYS) missing.push(`días distintos: ${ds.days} de ${AI_MIN_DAYS}`);
  if (ds.samples.length < AI_MIN_SAMPLES) missing.push(`comparaciones previsto-real: ${ds.samples.length} de ${AI_MIN_SAMPLES}`);
  if (slotsOk < AI_MIN_SLOTS) missing.push(`franjas del día con al menos ${AI_SLOT_MIN} comidas: ${slotsOk} de ${AI_MIN_SLOTS}`);
  const learnable = ds.baseRmse >= AI_MIN_BASE_RMSE;
  const enough = !missing.length;
  if (enough && !learnable) missing.push(`el modelo ya acierta bien (error medio ${Math.round(ds.baseRmse)} mg/dL): no hay mucho que aprender`);
  return { ready: enough && learnable, episodes: ds.episodes, days: ds.days, samples: ds.samples.length, baseRmse: ds.baseRmse, missing };
}

export interface TrainResult {
  useful: boolean;
  samples: number;
  episodes: number;
  valBase: number; // error del modelo base en las comidas de validación
  valModel: number; // error con la corrección
  hook: ResidualHook | null;
  dispose: () => void;
}

const clampN = (v: number, m: number): number => Math.max(-m, Math.min(m, v));

/** Entrena la red (carga TensorFlow.js la primera vez). Las comidas más recientes (25 %) se reservan para validar. */
export async function trainResidual(ds: Dataset, progress?: (msg: string) => void): Promise<TrainResult> {
  progress?.('Cargando TensorFlow.js…');
  const tf: typeof TFNS = await import('@tensorflow/tfjs');
  await tf.setBackend('cpu'); // un modelo diminuto: la CPU basta y evita crear contextos gráficos
  await tf.ready();

  const order: string[] = [];
  for (const x of ds.samples) if (!order.includes(x.ep)) order.push(x.ep); // ya están en orden de fecha
  const nVal = Math.max(8, Math.round(order.length * 0.25));
  const valIds = new Set(order.slice(-nVal));
  const train = ds.samples.filter((x) => !valIds.has(x.ep));
  const val = ds.samples.filter((x) => valIds.has(x.ep));
  const out: TrainResult = { useful: false, samples: ds.samples.length, episodes: order.length, valBase: 0, valModel: 0, hook: null, dispose: () => undefined };
  if (train.length < 100 || val.length < 40) return out;

  const build = (): TFNS.Sequential => {
    const m = tf.sequential();
    m.add(tf.layers.dense({ units: 12, activation: 'relu', inputShape: [N_FEATURES], kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }) }));
    m.add(tf.layers.dense({ units: 6, activation: 'relu', kernelRegularizer: tf.regularizers.l2({ l2: 0.01 }) }));
    m.add(tf.layers.dense({ units: 1 }));
    m.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' });
    return m;
  };
  const toT = (a: Sample[]) => ({ x: tf.tensor2d(a.map((s) => s.x)), y: tf.tensor2d(a.map((s) => [clampN(s.y, 120) / MAX_CORR])) });
  const predict = (m: TFNS.Sequential, a: Sample[]): number[] =>
    tf.tidy(() => Array.from((m.predict(tf.tensor2d(a.map((s) => s.x))) as TFNS.Tensor).dataSync()).map((v) => clampN(v * MAX_CORR, MAX_CORR)));
  const rmseOf = (a: Sample[], c: number[]): number => Math.sqrt(a.reduce((s, x, i) => s + (x.y - c[i]) ** 2, 0) / a.length);

  progress?.('Entrenando con las comidas anteriores…');
  const tr = toT(train);
  const va = toT(val);
  const m1 = build();
  const hist = await m1.fit(tr.x, tr.y, {
    epochs: 150,
    batchSize: 32,
    shuffle: true,
    validationData: [va.x, va.y],
    verbose: 0,
    callbacks: [tf.callbacks.earlyStopping({ monitor: 'val_loss', patience: 12 })],
  });
  const bestEpochs = Math.max(10, hist.epoch.length - 12);
  out.valBase = rmseOf(val, val.map(() => 0));
  out.valModel = rmseOf(val, predict(m1, val));
  tr.x.dispose(); tr.y.dispose(); va.x.dispose(); va.y.dispose();
  m1.dispose();
  out.useful = out.valBase > 0 && 1 - out.valModel / out.valBase >= AI_MIN_GAIN;
  if (!out.useful) return out;

  // validada: se reentrena con todas las comidas, el mismo número de épocas
  progress?.('Reentrenando con todos los datos…');
  const all = toT(ds.samples);
  const model = build();
  await model.fit(all.x, all.y, { epochs: bestEpochs, batchSize: 32, shuffle: true, verbose: 0 });
  all.x.dispose(); all.y.dispose();
  out.hook = (ctx, hs, deltas) => {
    if (!hs.length) return [];
    const x = hs.map((h, i) => features(ctx, h, deltas[i]));
    return tf.tidy(() => {
      const raw = Array.from((model.predict(tf.tensor2d(x)) as TFNS.Tensor).dataSync());
      // en el ancla (h = 0) la corrección es cero y entra poco a poco (la glucemia inicial es una medición)
      return raw.map((v, i) => clampN(v * MAX_CORR, MAX_CORR) * Math.min(1, hs[i] / 30));
    });
  };
  out.dispose = () => model.dispose();
  return out;
}
