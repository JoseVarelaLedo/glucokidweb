/**
 * Modelo predictivo de glucemia — SOLO INFORMATIVO.
 *
 * Idea: partiendo de la glucemia medida antes de comer (el "ancla"), la evolución esperable es
 *
 *     G(t) = G0 + [E(t) − E(t0)] + inercia(t)
 *
 * donde E(t) es el efecto acumulado, en mg/dL, de las comidas y de la insulina rápida:
 *
 *     E(t) = Σ hidratos · (mg/dL por gramo) · absorbido(t − t_comida)
 *          − Σ unidades · FS · actuado(t − t_dosis)
 *
 *  - FS (factor de sensibilidad): mg/dL que baja 1 U de rápida.
 *  - mg/dL por gramo de hidratos = FS / (gramos de hidratos que cubre 1 U).
 *  - "actuado": curva exponencial de insulina (modelo de OpenAPS/Loop) con duración y pico configurables.
 *  - "absorbido": curva parabólica de absorción de hidratos (más lenta si la comida lleva grasas/proteínas).
 *  - La insulina lenta se considera estable (la basal mantiene la glucemia sin comida).
 *  - El ejercicio, el estrés, la enfermedad, etc. NO están modelados: se avisa cuando hay ejercicio cerca.
 *
 * No es un dispositivo médico ni sustituye a la pauta del equipo de endocrinología.
 */
import { signal } from '@angular/core';
import { FOOD_GROUPS, makeDefaultModel, planTotal } from './defaults';
import { classify } from './glucose';
import { KALMAN, kInit, kPredict, kSd, kUpdate } from './kalman';
import { Arrow, DayRecord, Food, Meal, PredictModel, Reading, Settings } from './models';

/* ------------------------------------------------------------------ */
/* Utilidades                                                           */
/* ------------------------------------------------------------------ */

/** "HH:mm" → minutos desde las 00:00 (null si está vacío o mal formado). */
export function toMin(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function fmtTime(min: number): string {
  const m = Math.round(min);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** "40 g", "1,5 kg", "200 ml", "1/2 l" → gramos (los líquidos se asimilan a 1 g/ml). null si no se entiende. */
export function parseGrams(q: string | null | undefined): number | null {
  if (!q) return null;
  const m = /(\d+(?:[.,]\d+)?)\s*(kg|gramos?|gr|g|ml|cl|l|litros?)\b/i.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const u = m[2].toLowerCase();
  if (u === 'kg') return n * 1000;
  if (u.startsWith('l')) return n * 1000;
  if (u === 'cl') return n * 10;
  return n; // g, gr, gramos, ml
}

export function findFood(name: string, foods: Food[]): Food | null {
  const n = norm(name);
  if (n.length < 3) return null;
  const exact = foods.find((f) => norm(f.name) === n);
  if (exact) return exact;
  // coincidencia parcial: "pasta" ↔ "pasta cocida" (se elige la más larga para ser lo más específico)
  const cands = foods.filter((f) => {
    const fn = norm(f.name);
    return fn.length >= 3 && (fn.includes(n) || n.includes(fn));
  });
  cands.sort((a, b) => norm(b.name).length - norm(a.name).length);
  return cands[0] ?? null;
}

// Por nombre y no por posición: así se pueden añadir o reordenar grupos sin romper la detección de grasas.
const FAT_GROUP: string = FOOD_GROUPS.find((g) => g.startsWith('Proteínas y grasas')) ?? '';

/**
 * Alimento del catálogo sin hidratos (0 g por 100 g, como el brócoli, el pollo o el aceite): sus raciones no aportan hidratos
 * y no cuentan en ninguna suma. Un alimento que no está en el catálogo se cuenta tal cual lo anotado (no se puede saber).
 */
export function isCarbFree(name: string | null | undefined, foods: Food[]): boolean {
  const f = findFood(name ?? '', foods);
  return !!f && f.carbsPer100g <= 0;
}

/** Raciones de hidratos de una comida: las anotadas, sin las de alimentos sin hidratos. */
export function mealRations(meal: Meal, foods: Food[]): number {
  let n = 0;
  for (const it of meal.items ?? []) {
    if (typeof it.rations === 'number' && Number.isFinite(it.rations) && !isCarbFree(it.name, foods)) n += it.rations;
  }
  return n;
}

export interface MealCarbs {
  grams: number; // hidratos estimados
  /** Raciones anotadas directamente en los alimentos (las que llevan raciones, no las antiguas en gramos). */
  rations: number;
  unknown: string[]; // alimentos de los que no se pudo estimar nada
  hasFat: boolean; // lleva proteínas/grasas (absorción más lenta)
  matched: number;
}

/**
 * Hidratos de una comida. Si el alimento lleva RACIONES, se usan directamente (raciones × g de hidratos por ración:
 * no hace falta que el alimento esté en el catálogo). Los registros antiguos, con cantidad en texto («200 g»),
 * se siguen estimando con el catálogo de alimentos.
 */
export function mealCarbs(meal: Meal, foods: Food[], gPerRation = 10): MealCarbs {
  let grams = 0;
  let rations = 0;
  let matched = 0;
  let hasFat = false;
  const unknown: string[] = [];
  for (const it of meal.items) {
    const name = it.name?.trim();
    if (!name) continue;
    const f = findFood(name, foods);
    if (f?.group === FAT_GROUP) hasFat = true;
    // sin hidratos en el catálogo: no suma nada, ni siquiera con raciones anotadas
    if (f && f.carbsPer100g <= 0) continue;
    if (typeof it.rations === 'number' && Number.isFinite(it.rations) && it.rations >= 0) {
      rations += it.rations;
      grams += it.rations * gPerRation;
      matched++;
      continue;
    }
    if (!f) {
      unknown.push(`${name} (sin raciones)`);
      continue;
    }
    const g = parseGrams(it.quantity);
    if (g === null) {
      if (f.carbsPer100g > 0) unknown.push(`${name} (sin raciones)`);
      continue;
    }
    matched++;
    grams += (f.carbsPer100g * g) / 100;
  }
  return { grams, rations, unknown, hasFat, matched };
}

/* ------------------------------------------------------------------ */
/* Curvas                                                               */
/* ------------------------------------------------------------------ */

export function sanitizeModel(m?: Partial<PredictModel> | null): PredictModel {
  const d = makeDefaultModel();
  const dia = Math.min(Math.max(Number(m?.diaMin) || d.diaMin, 120), 480);
  const peak = Math.min(Math.max(Number(m?.peakMin) || d.peakMin, 30), dia * 0.45);
  const carb = Math.min(Math.max(Number(m?.carbMin) || d.carbMin, 60), 480);
  const carbFat = Math.min(Math.max(Number(m?.carbMinFat) || d.carbMinFat, carb), 600);
  return { diaMin: dia, peakMin: peak, carbMin: carb, carbMinFat: carbFat };
}

/** Fracción de la dosis que AÚN queda activa a los t minutos (curva exponencial de OpenAPS). */
export function iobFraction(t: number, model: PredictModel): number {
  const td = model.diaMin;
  const tp = model.peakMin;
  if (t <= 0) return 1;
  if (t >= td) return 0;
  const tau = (tp * (1 - tp / td)) / (1 - (2 * tp) / td);
  const a = (2 * tau) / td;
  const S = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
  const v = 1 - S * (1 - a) * (((t * t) / (tau * td * (1 - a)) - t / tau - 1) * Math.exp(-t / tau) + 1);
  return Math.min(1, Math.max(0, v));
}

const CARB_DELAY_MIN = 10;

/** Fracción de los hidratos ya absorbida a los t minutos (parabólica, con un pequeño retraso). */
export function carbAbsorbed(t: number, durationMin: number): number {
  const tt = t - CARB_DELAY_MIN;
  if (tt <= 0) return 0;
  if (tt >= durationMin) return 1;
  const x = tt / durationMin;
  return x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x);
}

/** mg/dL/min típicos de cada flecha del monitor. */
export const ARROW_RATE: Record<Arrow, number> = { up: 2.5, upRight: 1.5, flat: 0, downRight: -1.5, down: -2.5 };
export const MOMENTUM_TAU_MIN = 10;
/**
 * Una previsión por encima de esto (el techo de lectura de los sensores) no es creíble en un niño con insulina pautada: casi seguro hay un dato
 * mal (dosis sin anotar, raciones de más, hora equivocada o factor de sensibilidad inadecuado). En ese caso no se dibuja ni se usa.
 */
export const PRED_MAX_PLAUSIBLE = 400;
/**
 * Por debajo de esto una previsión tampoco es creíble (sería una hipoglucemia grave): casi seguro el factor de sensibilidad o la relación
 * raciones/unidades no encajan con el niño. No se enseña la cifra; se avisa de que el modelo no cuadra.
 */
export const PRED_MIN_PLAUSIBLE = 40;

/**
 * Ajuste del modelo aprendido de las curvas reales del sensor (ver `model-fit.ts`): `a` multiplica el efecto de los hidratos y `b` el de la insulina.
 * Solo se aplica si se calculó con los mismos Ajustes que hay ahora (`key`), porque si cambian el factor o la ratio ya no vale.
 */
export type Slot = 'manana' | 'mediodia' | 'noche';
/** Franjas del día en las que la sensibilidad puede ser distinta (por la hora de inicio de la comida). */
export const SLOTS: Array<{ id: Slot; label: string; from: number; to: number }> = [
  { id: 'manana', label: 'Mañana (hasta las 11 h)', from: 0, to: 660 },
  { id: 'mediodia', label: 'Mediodía (11–17 h)', from: 660, to: 1020 },
  { id: 'noche', label: 'Tarde y noche (desde las 17 h)', from: 1020, to: 1441 },
];
export const slotOf = (t: number): Slot => (SLOTS.find((x) => t >= x.from && t < x.to) ?? SLOTS[2]).id;

export interface SlotFit {
  active: boolean;
  a: number;
  b: number;
  episodes: number;
  points: number;
  rmseBefore: number | null; // error de la previsión con el ajuste general
  rmseAfter: number | null; // error con el ajuste de la franja (validación cruzada)
}

export interface ModelFit {
  /** Ajuste general (todas las comidas). */
  active: boolean;
  a: number;
  b: number;
  episodes: number;
  points: number;
  key: string;
  rmseBefore: number | null;
  rmseAfter: number | null;
  /** Ajuste propio de cada franja del día, si hay datos para ello (si no, se usa el general). */
  slots?: Partial<Record<Slot, SlotFit>>;
}
export const NO_FIT: ModelFit = { active: false, a: 1, b: 1, episodes: 0, points: 0, key: '', rmseBefore: null, rmseAfter: null, slots: {} };

/** Contexto de un episodio: lo que necesita una corrección aprendida (ver `residual-ai.ts`). */
export interface ResidualCtx {
  g0: number;
  rate: number; // mg/dL/min de la flecha inicial
  hour: number; // hora decimal de inicio
  carbG: number;
  units: number;
  iob: number;
  fat: boolean;
}
/** Corrección (mg/dL) para cada instante `hs` (min desde el inicio) dada la previsión base `deltas` (mg/dL sobre la glucemia inicial). */
export type ResidualHook = (ctx: ResidualCtx, hs: number[], deltas: number[]) => number[];
/** Corrección aprendida activa (la usa solo la curva que se enseña, no la evaluación del modelo). */
export const residualHook = signal<ResidualHook | null>(null);
export const modelFit = signal<ModelFit>(NO_FIT);

/** Clave de los Ajustes de los que depende el ajuste aprendido. */
export function fitKey(s: Settings): string {
  return JSON.stringify([s.isf, s.gramsPerRation, s.unitsPerRation, sanitizeModel(s.model)]);
}

/** Serie del sensor (`[minuto, mg/dL, …]`) → puntos ordenados. */
export function sensorPoints(series: number[] | undefined | null): CurvePoint[] {
  const out: CurvePoint[] = [];
  if (!series) return out;
  for (let i = 0; i + 1 < series.length; i += 2) {
    const t = Number(series[i]);
    const g = Number(series[i + 1]);
    if (Number.isFinite(t) && Number.isFinite(g) && g > 0) out.push({ t, g });
  }
  return out.sort((x, y) => x.t - y.t);
}

/* ------------------------------------------------------------------ */
/* Eventos del día                                                      */
/* ------------------------------------------------------------------ */

export interface InsulinEvent {
  t: number;
  units: number;
  label: string;
}
export interface CarbEvent {
  /** Comida de la que sale (si la hay): sirve para no perder los hidratos que se toman ANTES de inyectar. */
  mealId?: string;
  t: number;
  grams: number;
  durationMin: number;
  label: string;
}

export interface DayEvents {
  insulin: InsulinEvent[];
  carbs: CarbEvent[];
  /** Cosas que impiden usarlas en el modelo (se muestran como avisos de fiabilidad). */
  issues: Array<{ mealId: string; text: string }>;
}

export function dayEvents(day: DayRecord, s: Settings, foods: Food[]): DayEvents {
  const model = sanitizeModel(s.model);
  const gPerRation = s.gramsPerRation > 0 ? s.gramsPerRation : 10;
  const out: DayEvents = { insulin: [], carbs: [], issues: [] };

  for (const m of day.meals) {
    if (m.kind !== 'rapida') continue;
    const tIns = toMin(m.before.time);
    const units = m.before.units ?? 0;
    const items = m.items.filter((i) => i.name?.trim());

    if (units > 0) {
      if (tIns === null) out.issues.push({ mealId: m.injectionId, text: `${m.name}: falta la hora de la dosis; no se puede incluir en la previsión.` });
      else out.insulin.push({ t: tIns, units, label: m.name });
    }
    if (items.length) {
      const c = mealCarbs(m, foods, gPerRation);
      const tFood = toMin(m.foodTime) ?? tIns;
      if (c.unknown.length) {
        out.issues.push({ mealId: m.injectionId, text: `${m.name}: no se han podido estimar los hidratos de ${c.unknown.join(', ')}.` });
      }
      if (c.grams > 0) {
        if (tFood === null) out.issues.push({ mealId: m.injectionId, text: `${m.name}: falta la hora de la comida.` });
        else out.carbs.push({ mealId: m.injectionId, t: tFood, grams: c.grams, durationMin: c.hasFat ? model.carbMinFat : model.carbMin, label: m.name });
      }
    }
  }
  for (const x of day.extras) {
    const g = (x.extraRations ?? 0) * gPerRation;
    const t = toMin(x.time);
    if (g > 0 && t !== null) out.carbs.push({ t, grams: g, durationMin: model.carbMin, label: 'Raciones adicionales' });
  }
  return out;
}

/**
 * Insulina rápida activa (U) en el minuto t, según las dosis registradas.
 * `onlyBefore`: si se indica, solo cuenta las dosis anteriores a ese minuto
 * (sirve para saber cuánta insulina "heredada" había al empezar una comida).
 */
export function iobAt(events: DayEvents, t: number, s: Settings, onlyBefore = Infinity): number {
  const model = sanitizeModel(s.model);
  let u = 0;
  for (const e of events.insulin) if (e.t <= t && e.t < onlyBefore) u += e.units * iobFraction(t - e.t, model);
  return u;
}

/* ------------------------------------------------------------------ */
/* Predicción por comida                                                */
/* ------------------------------------------------------------------ */

export interface CurvePoint {
  t: number; // minutos del día
  g: number; // mg/dL
}

export type Level = 'info' | 'atencion' | 'alerta' | 'ok';
export interface Recommendation {
  level: Level;
  code: string;
  text: string;
}

export interface Deviation {
  t: number;
  measured: number;
  predicted: number;
  dev: number;
  label: string;
}

export interface Episode {
  mealId: string;
  name: string;
  t0: number;
  g0: number;
  arrow: Arrow | null;
  points: CurvePoint[];
  nadir: CurvePoint | null;
  peak: CurvePoint | null;
  endG: number | null;
  iobStart: number;
  deviations: Deviation[];
  meanDev: number | null;
  confidence: 'alta' | 'media' | 'baja';
  recs: Recommendation[];
  /** Pico que habría salido si la previsión no se hubiera descartado por imposible (solo si se descartó). */
  rawPeak?: number;
  /** Idem por abajo: la mínima que habría salido si se descartó por irreal (hipoglucemia imposible). */
  rawNadir?: number;
  ctx?: ResidualCtx;
  /** Glucemia estimada (previsión + error filtrado) en `nowT`. */
  nowEst?: number;
  /** Si hay una lectura posterior al ancla (sensor o medición anotada), la previsión futura se rehízo desde ella. */
  nowT?: number;
  nowG?: number;
}

export interface MeasuredPoint {
  t: number;
  g: number;
  arrow: Arrow | null;
  kind: 'before' | 'after' | 'monitor' | 'capilar' | 'ejercicio';
  label: string;
  note?: string;
}

export interface DayAnalysis {
  measured: MeasuredPoint[];
  doses: Array<{ t: number; units: number; label: string }>;
  episodes: Episode[];
  /** Avisos generales (falta configuración, datos incompletos…). */
  general: Recommendation[];
  ready: boolean;
}

export const DEVIATION_TOLERANCE = 25; // mg/dL: por debajo se considera "acorde"
export const DEVIATION_ALERT = 40; // mg/dL: a partir de aquí se explica la desviación

/** Efecto acumulado de comidas (c, sube) e insulina (i, baja), en mg/dL positivos, en el minuto t. */
export function effectParts(ev: DayEvents, t: number, isf: number, gPerUnit: number, model: PredictModel, until: number): { c: number; i: number } {
  const csf = isf / gPerUnit; // mg/dL por gramo
  let c = 0;
  let i = 0;
  for (const x of ev.carbs) if (x.t < until) c += csf * x.grams * carbAbsorbed(t - x.t, x.durationMin);
  for (const x of ev.insulin) if (x.t < until) i += isf * x.units * (1 - iobFraction(t - x.t, model));
  return { c, i };
}

/** Efecto neto (mg/dL) en el minuto t, con el ajuste aprendido (a = hidratos, b = insulina). */
function effect(ev: DayEvents, t: number, isf: number, gPerUnit: number, model: PredictModel, until: number, a = 1, b = 1): number {
  const p = effectParts(ev, t, isf, gPerUnit, model, until);
  return a * p.c - b * p.i;
}

function measuredPoints(day: DayRecord): MeasuredPoint[] {
  const out: MeasuredPoint[] = [];
  const add = (r: Reading, kind: MeasuredPoint['kind'], label: string, note?: string) => {
    const t = toMin(r.time);
    if (t === null || r.value === null || r.value === undefined) return;
    out.push({ t, g: r.value, arrow: r.arrow, kind, label, note });
  };
  for (const m of day.meals) {
    add(m.before, 'before', m.kind === 'lenta' ? m.name : `Antes de ${m.name.toLowerCase()}`);
    add(m.after, 'after', `Al terminar ${m.name.toLowerCase()}`);
  }
  for (const x of day.extras) add(x, x.source === 'capilar' ? 'capilar' : 'monitor', 'Medición intermedia', x.note);
  for (const a of day.activities) {
    // las lecturas de ejercicio no llevan hora propia: se sitúan en el inicio y el final del intervalo
    const s0 = toMin(a.start);
    const e0 = toMin(a.end);
    if (s0 !== null && a.before.value !== null) out.push({ t: s0, g: a.before.value, arrow: a.before.arrow, kind: 'ejercicio', label: `Antes de ${a.type || 'ejercicio'}` });
    if (e0 !== null && a.after.value !== null) out.push({ t: e0, g: a.after.value, arrow: a.after.arrow, kind: 'ejercicio', label: `Al terminar ${a.type || 'ejercicio'}` });
  }
  return out.sort((a, b) => a.t - b.t);
}

function exerciseNear(day: DayRecord, t0: number, tEnd: number): string | null {
  for (const a of day.activities) {
    const s = toMin(a.start);
    const e = toMin(a.end) ?? s;
    if (s === null || e === null) continue;
    // terminó en las 6 h previas, o transcurre/empieza dentro del episodio
    if ((e <= t0 && t0 - e <= 360) || (s < tEnd && e >= t0)) return a.type || 'actividad física';
  }
  return null;
}

export function analyzeDay(day: DayRecord, s: Settings, foods: Food[], fit: ModelFit | null = modelFit(), residual: ResidualHook | null = null): DayAnalysis {
  const model = sanitizeModel(s.model);
  const fitOk = !!fit && fit.key === fitKey(s);
  const sensorPts = sensorPoints(day.sensor);
  const isf = s.isf && s.isf > 0 ? s.isf : 0;
  const gPerRation = s.gramsPerRation > 0 ? s.gramsPerRation : 10;
  const uPerRation = s.unitsPerRation > 0 ? s.unitsPerRation : 1;
  const gPerUnit = gPerRation / uPerRation;
  const target = s.targetGlucose && s.targetGlucose > 0 ? s.targetGlucose : 150;

  const measured = measuredPoints(day);
  const events = dayEvents(day, s, foods);
  const doses = day.meals
    .filter((m) => (m.before.units ?? 0) > 0 && toMin(m.before.time) !== null)
    .map((m) => ({ t: toMin(m.before.time) as number, units: m.before.units as number, label: `${m.name} (${m.kind === 'lenta' ? 'lenta' : 'rápida'})` }));

  const general: Recommendation[] = [];
  const result: DayAnalysis = { measured, doses, episodes: [], general, ready: false };

  if (!isf) {
    general.push({
      level: 'info',
      code: 'sin-fs',
      text: 'Para ver la curva prevista, calcula el factor de sensibilidad en Ajustes (insulina diaria total).',
    });
    return result;
  }
  result.ready = true;

  // Anclas: cada comida de rápida con glucemia y hora previas
  const rapid = day.meals.filter((m) => m.kind === 'rapida');
  const anchors = rapid
    .map((m) => ({ m, t0: toMin(m.before.time), g0: m.before.value }))
    .filter((a): a is { m: Meal; t0: number; g0: number } => a.t0 !== null && a.g0 !== null && a.g0 !== undefined)
    .sort((a, b) => a.t0 - b.t0);

  const startedMeals = rapid.filter((m) => m.before.value !== null || (m.before.units ?? 0) > 0 || m.items.length > 0);
  for (const m of startedMeals) {
    if (!anchors.some((a) => a.m.injectionId === m.injectionId) && (m.before.units ?? 0) > 0) {
      general.push({ level: 'info', code: 'sin-ancla', text: `${m.name}: sin glucemia y hora previas no se puede calcular la previsión.` });
    }
  }
  for (const i of events.issues) general.push({ level: 'info', code: 'dato', text: i.text });

  for (let k = 0; k < anchors.length; k++) {
    const { m, t0, g0 } = anchors[k];
    const nextT = k + 1 < anchors.length ? anchors[k + 1].t0 : Infinity;
    const horizon = Math.min(t0 + model.diaMin, nextT);
    const recs: Recommendation[] = [];
    const ep: Episode = {
      mealId: m.injectionId,
      name: m.name,
      t0,
      g0,
      arrow: m.before.arrow,
      points: [],
      nadir: null,
      peak: null,
      endG: null,
      iobStart: iobAt(events, t0, s, t0 - 1),
      deviations: [],
      meanDev: null,
      confidence: 'alta',
      recs,
    };

    // los hidratos de esta comida cuentan aunque se empiecen a tomar antes de inyectar (inyección tardía o «pre-bolus» negativo)
    const myCarbs = events.carbs.filter((c) => c.mealId === m.injectionId || (c.t >= t0 - 1 && c.t < horizon));
    const myIns = events.insulin.filter((i) => i.t >= t0 - 1 && i.t < horizon);

    // --- Precondiciones: cuándo NO se predice ---
    const cls = classify(g0, m.before.arrow);
    if (g0 < 70) {
      recs.push({ level: 'alerta', code: 'hipo-inicial', text: `Glucemia inicial ${g0} mg/dL (hipoglucemia): no se calcula previsión. Sigue el protocolo de hipoglucemia de vuestro equipo médico.` });
      ep.confidence = 'baja';
      result.episodes.push(ep);
      continue;
    }
    if (!myCarbs.length && !myIns.length && ep.iobStart < 0.25) {
      // Sin comida, sin insulina y sin insulina previa activa: nada que predecir
      result.episodes.push(ep);
      continue;
    }

    // --- Datos incoherentes: no se predice ---
    const carbG = myCarbs.reduce((a, c) => a + c.grams, 0);
    if (carbG > 0 && !myIns.length && m.before.units == null) {
      recs.push({
        level: 'atencion',
        code: 'sin-dosis',
        text: `${m.name}: hay hidratos anotados (≈ ${Math.round(carbG)} g) pero no hay dosis de insulina. Anota las unidades (y la hora) para ver la previsión; sin ellas saldría una subida que no es real. Si de verdad no se ha puesto insulina, anota 0 U.`,
      });
      ep.confidence = 'baja';
      result.episodes.push(ep);
      continue;
    }

    // --- Curva ---
    // ajuste aprendido: el de la franja del día si lo hay, y si no el general
    const slotFit = fitOk ? fit?.slots?.[slotOf(t0)] : undefined;
    const sel = slotFit?.active ? slotFit : fitOk && fit?.active ? fit : null;
    const fa = sel ? sel.a : 1;
    const fb = sel ? sel.b : 1;
    const useFit = !!sel;
    // 1) Previsión «pura» desde el ancla (es la que se compara con lo medido para evaluar el modelo)
    const e0 = effect(events, t0, isf, gPerUnit, model, horizon, fa, fb);
    const rate = m.before.arrow ? ARROW_RATE[m.before.arrow] : 0;
    const step = 5;
    const forecast: CurvePoint[] = [];
    for (let t = t0; t <= horizon + 0.01; t += step) {
      const mom = rate * MOMENTUM_TAU_MIN * (1 - Math.exp(-(t - t0) / MOMENTUM_TAU_MIN));
      const g = g0 + (effect(events, t, isf, gPerUnit, model, horizon, fa, fb) - e0) + mom;
      forecast.push({ t, g: Math.max(0, Math.round(g * 10) / 10) });
    }
    ep.ctx = {
      g0,
      rate,
      hour: t0 / 60,
      carbG,
      units: myIns.reduce((acc, i) => acc + i.units, 0),
      iob: ep.iobStart,
      fat: myCarbs.some((c) => c.durationMin > model.carbMin),
    };
    // corrección aprendida (opcional, solo si el usuario la ha activado y ha superado su validación)
    if (residual) {
      const hs = forecast.map((x) => x.t - t0);
      const corr = residual(ep.ctx, hs, forecast.map((x) => x.g - g0));
      for (let i = 0; i < forecast.length; i++) forecast[i].g = Math.max(0, Math.round((forecast[i].g + (corr[i] || 0)) * 10) / 10);
    }
    const at = (t: number): number => predictedAt({ points: forecast } as Episode, t) ?? forecast[forecast.length - 1].g;

    // 2) Filtro de Kalman: con las lecturas posteriores al ancla (serie del sensor y mediciones anotadas) se estima cuánto se aparta la
    //    realidad de la previsión y cómo evoluciona esa diferencia; la parte futura de la curva se corrige con ello (ver kalman.ts).
    const known: Array<{ t: number; g: number; r: number }> = [
      ...sensorPts.filter((x) => x.t > t0 && x.t <= horizon).map((x) => ({ t: x.t, g: x.g, r: KALMAN.rSensor })),
      ...measured.filter((x) => x.t > t0 && x.t <= horizon).map((x) => ({ t: x.t, g: x.g, r: KALMAN.rManual })),
    ].sort((x, y) => x.t - y.t);
    const last = known.length ? known[known.length - 1] : null;
    let pts: CurvePoint[] = forecast;
    if (last && last.t < horizon - 10) {
      let st = kInit(t0);
      for (const o of known) {
        st = kPredict(st, o.t);
        st = kUpdate(st, o.g - at(o.t), o.r);
      }
      const est = at(last.t) + st.e;
      pts = forecast.filter((x) => x.t < last.t);
      pts.push({ t: last.t, g: Math.max(0, Math.round(est * 10) / 10) });
      let tt = t0 + Math.floor((last.t - t0) / step + 1) * step;
      for (; tt <= horizon + 0.01; tt += step) {
        const sp = kPredict(st, tt);
        pts.push({ t: tt, g: Math.max(0, Math.round((at(tt) + sp.e) * 10) / 10) });
      }
      ep.nowT = last.t;
      ep.nowG = last.g;
      ep.nowEst = Math.round(est);
      void kSd;
    }
    const implausible = (g: number) => g > PRED_MAX_PLAUSIBLE || g < PRED_MIN_PLAUSIBLE;
    const fromT = ep.nowT ?? t0;
    // la parte anterior a la última lectura ya no es una previsión: si era absurda, simplemente no se dibuja
    if (ep.nowT !== undefined && pts.some((x) => x.t < fromT && implausible(x.g))) pts = pts.filter((x) => x.t >= fromT);
    ep.points = pts;
    const future = pts.filter((x) => x.t >= fromT);
    ep.nadir = future.reduce((a, b) => (b.g < a.g ? b : a));
    ep.peak = future.reduce((a, b) => (b.g > a.g ? b : a));
    ep.endG = pts[pts.length - 1]?.g ?? null;

    if (ep.peak.g > PRED_MAX_PLAUSIBLE || ep.nadir.g < PRED_MIN_PLAUSIBLE) {
      // Imposible con insulina pautada: se descarta la curva y se explica qué revisar, en vez de enseñar un valor alarmante e irreal.
      const high = ep.peak.g > PRED_MAX_PLAUSIBLE;
      ep.rawPeak = Math.round(ep.peak.g);
      ep.rawNadir = Math.round(ep.nadir.g);
      ep.points = [];
      ep.nadir = null;
      ep.peak = null;
      ep.endG = null;
      ep.confidence = 'baja';
      recs.push({
        level: 'atencion',
        code: 'prevision-imposible',
        text: high
          ? `${m.name}: con los datos anotados la previsión pasaría de ${PRED_MAX_PLAUSIBLE} mg/dL (≈ ${ep.rawPeak}), algo que no es creíble con la insulina puesta con regularidad, así que no se dibuja. ` +
            `Casi seguro hay un dato por revisar: raciones de más (¿alguna de un alimento sin hidratos?), una dosis sin anotar o con la hora equivocada, o un factor de sensibilidad o una relación raciones/unidades en Ajustes que no corresponde. ` +
            `Esto no es un aviso médico: si dudas de la glucemia real, mide.`
          : `${m.name}: con los datos anotados el modelo bajaría de ${PRED_MIN_PLAUSIBLE} mg/dL (≈ ${ep.rawNadir}), algo que no coincide con lo que se ha medido, así que no se dibuja ni se avisa con esa cifra. ` +
            `Lo más probable es que el factor de sensibilidad (sale de la insulina diaria total) o la relación raciones/unidades de Ajustes no encajen con cómo responde el niño, o que falte anotar algún hidrato. ` +
            `Esto no es un aviso médico: manda la glucemia real, y si la tendencia del monitor es descendente, mide.`,
      });
      result.episodes.push(ep);
      continue;
    }

    // --- Desviaciones frente a lo medido en este episodio (siempre contra la previsión «pura», no la rehecha) ---
    const pure = { points: forecast } as Episode;
    for (const p of measured) {
      if (p.t <= t0 || p.t > horizon) continue;
      const pred = predictedAt(pure, p.t);
      if (pred === null) continue;
      ep.deviations.push({ t: p.t, measured: p.g, predicted: pred, dev: p.g - pred, label: p.label });
    }
    if (ep.deviations.length) ep.meanDev = ep.deviations.reduce((a, d) => a + d.dev, 0) / ep.deviations.length;

    // --- Fiabilidad ---
    const mealIssues = events.issues.filter((i) => i.mealId === m.injectionId);
    const exercise = exerciseNear(day, t0, horizon);
    let penalty = mealIssues.length + (exercise ? 1 : 0) + (ep.iobStart > 2 ? 1 : 0);
    if (m.items.length === 0 && (m.before.units ?? 0) > 0) penalty += 1;
    ep.confidence = penalty === 0 ? 'alta' : penalty === 1 ? 'media' : 'baja';

    /* ---------------- Subalgoritmo de recomendaciones ---------------- */

    // R1 · riesgo de hipoglucemia prevista (solo del futuro: lo ya medido no es una previsión)
    const since = ep.nowT !== undefined ? ` (previsión corregida con las lecturas hasta las ${fmtTime(ep.nowT)}; última lectura ${Math.round(ep.nowG as number)} mg/dL)` : '';
    if (ep.nowG !== undefined && ep.nowG < 70) {
      recs.push({ level: 'alerta', code: 'hipo-actual', text: `La última lectura (${fmtTime(ep.nowT as number)}) fue ${Math.round(ep.nowG)} mg/dL: sigue el protocolo de hipoglucemia de vuestro equipo médico.` });
    }
    const futureNadir = ep.nadir && ep.nadir.t > fromT + 4 ? ep.nadir : null;
    if (futureNadir && futureNadir.g < 70 && !(ep.nowG !== undefined && ep.nowG < 70)) {
      // sin lecturas posteriores ni ajuste con las curvas reales, la cifra sale solo de las reglas generales de Ajustes: se avisa, pero con menos alarma
      const grounded = useFit || ep.nowT !== undefined;
      recs.push({
        level: grounded ? 'alerta' : 'atencion',
        code: 'hipo-prevista',
        text:
          `Se prevé bajar a ≈${Math.round(futureNadir.g)} mg/dL hacia las ${fmtTime(futureNadir.t)}${since}. Valora medir antes de esa hora y tener a mano hidratos de acción rápida, según vuestro protocolo.` +
          (grounded ? '' : ' Ojo: esta cifra sale solo de los factores de Ajustes, sin contrastar con las curvas reales del sensor de este niño; puede estar exagerada.'),
      });
    } else if (futureNadir && futureNadir.g < 90 && futureNadir.t > fromT + 20) {
      recs.push({
        level: 'atencion',
        code: 'bajada-prevista',
        text: `La previsión baja hasta ≈${Math.round(futureNadir.g)} mg/dL hacia las ${fmtTime(futureNadir.t)}${since}: conviene vigilar la tendencia en ese tramo.`,
      });
    }

    // R2 · pico alto previsto
    if (ep.peak && ep.peak.g > 350) {
      recs.push({
        level: 'alerta',
        code: 'pico-muy-alto',
        text: `Pico previsto ≈${Math.round(ep.peak.g)} mg/dL hacia las ${fmtTime(ep.peak.t)}. Si la glucemia se mantiene muy alta, sigue la pauta del equipo médico (p. ej. cuándo comprobar cetonas).`,
      });
    } else if (ep.peak && ep.peak.g > 250) {
      recs.push({
        level: 'atencion',
        code: 'pico-alto',
        text: `Pico previsto ≈${Math.round(ep.peak.g)} mg/dL hacia las ${fmtTime(ep.peak.t)}. Si se repite en varios días, comentad con el equipo médico el momento del bolo (antes de comer) o la ratio.`,
      });
    }

    // R3 · final del episodio alto (dosis corta / hidratos infraestimados)
    if (ep.endG !== null && ep.endG > 180 && horizon - t0 >= model.diaMin - 1) {
      recs.push({
        level: 'info',
        code: 'final-alto',
        text: `Al terminar la acción de la insulina (≈${fmtTime(horizon)}) la previsión queda en ≈${Math.round(ep.endG)} mg/dL: la dosis podría quedarse corta o los hidratos estar infraestimados.`,
      });
    }

    // R4 · dosis registrada frente a la calculada por ratio (+ corrección por glucemia alta)
    const carbEstimate = mealCarbs(m, foods, gPerRation);
    if (carbEstimate.grams > 0 && (m.before.units ?? 0) > 0) {
      const byRatio = (carbEstimate.grams / gPerRation) * uPerRation;
      const corr = g0 > target ? Math.round((g0 - target) / isf) : 0;
      const expected = byRatio + corr;
      const given = m.before.units as number;
      if (Math.abs(given - expected) >= 1 && Math.abs(given - byRatio) >= 1) {
        const dirTxt = given < expected ? 'inferior' : 'superior';
        recs.push({
          level: 'info',
          code: 'dosis-distinta',
          text: `Dosis registrada ${fmt(given)} U, ${dirTxt} a la que salen los datos (${fmt(byRatio)} U por la ratio${corr ? ` + ${corr} U de corrección` : ''} ≈ ${fmt(expected)} U). Puede ser intencionado; si no, revisa las cantidades.`,
        });
      }
    }

    // R4b · raciones anotadas frente a las previstas para esta comida (Ajustes)
    const planned = planTotal(s.injections.find((i) => i.id === m.injectionId)?.plan);
    if (planned > 0 && carbEstimate.matched > 0) {
      const diff = carbEstimate.rations - planned;
      if (Math.abs(diff) >= 1) {
        const units = Math.abs(diff) * uPerRation;
        const effect = isf > 0 ? ` (≈ ${Math.round(units * isf)} mg/dL)` : '';
        recs.push({
          level: 'info',
          code: 'raciones-previstas',
          text: `Raciones anotadas: ${fmt(carbEstimate.rations)}, ${fmt(Math.abs(diff))} ${diff < 0 ? 'menos' : 'más'} que las previstas (${fmt(planned)}). Esa diferencia equivale a ≈ ${fmt(units)} U${effect}: si la glucemia se desvió, puede explicarlo.`,
        });
      }
    }

    // R5 · insulina activa de comidas anteriores
    if (ep.iobStart >= 1) {
      recs.push({
        level: ep.iobStart > 2 && g0 < 120 ? 'atencion' : 'info',
        code: 'iob-previa',
        text: `Al empezar quedaban ≈${fmt(ep.iobStart)} U de rápida activa de dosis anteriores (ya incluidas en la previsión).`,
      });
    }

    // R6 · tendencia a la baja en el momento de inyectar
    if (m.before.arrow && (m.before.arrow === 'down' || m.before.arrow === 'downRight') && g0 <= 110 && (m.before.units ?? 0) > 0) {
      recs.push({
        level: 'atencion',
        code: 'flecha-abajo',
        text: `Se inyectó con glucemia ${g0} y tendencia a la baja: vigila las siguientes lecturas.`,
      });
    }

    // R7 · ejercicio cerca (el modelo no lo incluye)
    if (exercise) {
      recs.push({
        level: 'atencion',
        code: 'ejercicio',
        text: `Hubo o hay ${exercise.toLowerCase()} cerca de esta comida: el ejercicio suele aumentar el riesgo de bajadas (también horas después) y el modelo no lo incluye, por lo que esta previsión es menos fiable.`,
      });
    }

    // R8 · calidad de datos
    for (const i of mealIssues) recs.push({ level: 'info', code: 'dato', text: i.text });
    if (cls?.cls === 'hiper' || g0 > 350) {
      recs.push({ level: 'alerta', code: 'hiper-inicial', text: `Glucemia inicial ${g0} mg/dL (hiperglucemia). Sigue la pauta del equipo médico (p. ej. cetonas, corrección).` });
    }

    // R9 · desviación frente a lo medido
    if (ep.deviations.length) {
      const worst = ep.deviations.reduce((a, b) => (Math.abs(b.dev) > Math.abs(a.dev) ? b : a));
      if (worst.dev >= DEVIATION_ALERT) {
        recs.push({
          level: 'atencion',
          code: 'desv-alta',
          text: `A las ${fmtTime(worst.t)} la glucemia fue ${Math.round(worst.measured)}, +${Math.round(worst.dev)} mg/dL sobre lo previsto (${Math.round(worst.predicted)}). Posibles causas: hidratos infraestimados, bolo tardío respecto a la comida, grasas/proteínas que retrasan la absorción, estrés o enfermedad.`,
        });
      } else if (worst.dev <= -DEVIATION_ALERT) {
        recs.push({
          level: 'atencion',
          code: 'desv-baja',
          text: `A las ${fmtTime(worst.t)} la glucemia fue ${Math.round(worst.measured)}, ${Math.round(worst.dev)} mg/dL bajo lo previsto (${Math.round(worst.predicted)}). Posibles causas: dosis algo alta, ejercicio, o no comió todo lo anotado.`,
        });
      } else if (Math.abs(worst.dev) <= DEVIATION_TOLERANCE) {
        recs.push({ level: 'ok', code: 'desv-ok', text: 'La evolución medida coincide con la prevista (dentro de ±25 mg/dL).' });
      }
    }

    result.episodes.push(ep);
  }

  return result;
}

export function predictedAt(ep: Episode, t: number): number | null {
  const pts = ep.points;
  if (pts.length < 2 || t < pts[0].t || t > pts[pts.length - 1].t) return null;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      const f = (t - a.t) / (b.t - a.t || 1);
      return a.g + (b.g - a.g) * f;
    }
  }
  return null;
}

const fmt = (n: number): string => n.toLocaleString('es-ES', { maximumFractionDigits: 1 });

/* ------------------------------------------------------------------ */
/* Patrones en varios días                                              */
/* ------------------------------------------------------------------ */

export interface PatternFinding {
  level: Level;
  text: string;
}

export function analyzePatterns(days: DayRecord[], s: Settings, foods: Food[]): { findings: PatternFinding[]; daysUsed: number } {
  const findings: PatternFinding[] = [];
  const byMeal = new Map<string, { name: string; early: number[]; late: number[]; hypos: number }>();
  let used = 0;

  for (const day of days) {
    const an = analyzeDay(day, s, foods);
    if (!an.ready) continue;
    let counted = false;
    for (const ep of an.episodes) {
      if (!ep.deviations.length) continue;
      counted = true;
      const rec = byMeal.get(ep.mealId) ?? { name: ep.name, early: [], late: [], hypos: 0 };
      for (const d of ep.deviations) {
        const dt = d.t - ep.t0;
        if (dt >= 60 && dt <= 180) rec.early.push(d.dev);
        else if (dt > 180) rec.late.push(d.dev);
      }
      byMeal.set(ep.mealId, rec);
    }
    // hipoglucemias medidas en la ventana de cada comida
    for (const ep of an.episodes) {
      const rec = byMeal.get(ep.mealId);
      if (!rec) continue;
      const lows = an.measured.filter((p) => p.t > ep.t0 && p.t <= ep.t0 + 300 && p.g < 70).length;
      rec.hypos += lows > 0 ? 1 : 0;
    }
    if (counted) used++;
  }

  const median = (a: number[]) => {
    const v = [...a].sort((x, y) => x - y);
    const n = v.length;
    return n === 0 ? 0 : n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  };

  for (const [, r] of byMeal) {
    for (const [label, arr] of [['en las 1–3 h siguientes', r.early], ['pasadas 3 h', r.late]] as const) {
      if (arr.length < 4) continue;
      const med = median(arr);
      if (med >= 30) {
        findings.push({
          level: 'atencion',
          text: `${r.name}: la glucemia ${label} suele quedar por encima de lo previsto (mediana +${Math.round(med)} mg/dL en ${arr.length} lecturas). Si persiste, comentad con el equipo médico la ratio o el momento del bolo.`,
        });
      } else if (med <= -30) {
        findings.push({
          level: 'atencion',
          text: `${r.name}: la glucemia ${label} suele quedar por debajo de lo previsto (mediana ${Math.round(med)} mg/dL en ${arr.length} lecturas). Si persiste, comentadlo con el equipo médico (posible dosis o ratio algo altas).`,
        });
      }
    }
    if (r.hypos >= 2) {
      findings.push({ level: 'alerta', text: `${r.name}: ${r.hypos} días con hipoglucemia en las 5 h siguientes en este periodo. Conviene revisarlo con el equipo médico.` });
    }
  }
  if (!findings.length) {
    findings.push({ level: 'ok', text: used ? 'No se observan patrones claros de desviación en este periodo.' : 'Aún no hay suficientes mediciones tras las comidas para detectar patrones.' });
  }
  return { findings, daysUsed: used };
}

/* ------------------------------------------------------------------ */
/* Corrección de hiperglucemia                                          */
/* ------------------------------------------------------------------ */

export interface CorrectionResult {
  diff: number;
  exact: number;
  units: number;
}

/** (glucemia real − objetivo) / factor de sensibilidad, redondeado a unidades enteras (nunca negativo). */
export function correctionUnits(current: number, target: number, isf: number): CorrectionResult {
  const diff = current - target;
  const exact = isf > 0 ? diff / isf : 0;
  return { diff, exact, units: Math.max(0, Math.round(exact)) };
}

/** Constante de la regla del factor de sensibilidad: FS = 1700 ÷ insulina diaria total. */
export const ISF_RULE = 1700;

/** Factor de sensibilidad (mg/dL que baja 1 U) = 1700 ÷ insulina diaria total (rápida + lenta). */
export function sensitivityFactor(dailyRapid: number, dailyLenta: number, rule: number = ISF_RULE): { total: number; isf: number } | null {
  const total = (dailyRapid || 0) + (dailyLenta || 0);
  if (!(total > 0) || !(rule > 0)) return null;
  return { total, isf: Math.round((rule / total) * 10) / 10 };
}

/** Ratio de hidratos orientativa por la "regla de 500" (gramos que cubre 1 U). */
export function carbRatioHint(total: number): number | null {
  return total > 0 ? Math.round((500 / total) * 10) / 10 : null;
}
