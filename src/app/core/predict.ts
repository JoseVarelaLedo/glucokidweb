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
import { FOOD_GROUPS, makeDefaultModel } from './defaults';
import { classify } from './glucose';
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

const FAT_GROUP = FOOD_GROUPS[5]; // 'Proteínas y grasas (sin hidratos)'

export interface MealCarbs {
  grams: number; // hidratos estimados
  unknown: string[]; // alimentos de los que no se pudo estimar nada
  hasFat: boolean; // lleva proteínas/grasas (absorción más lenta)
  matched: number;
}

export function mealCarbs(meal: Meal, foods: Food[]): MealCarbs {
  let grams = 0;
  let matched = 0;
  let hasFat = false;
  const unknown: string[] = [];
  for (const it of meal.items) {
    if (!it.name?.trim()) continue;
    const f = findFood(it.name, foods);
    if (!f) {
      unknown.push(it.name.trim());
      continue;
    }
    if (f.group === FAT_GROUP) hasFat = true;
    const g = parseGrams(it.quantity);
    if (g === null) {
      if (f.carbsPer100g > 0) unknown.push(`${it.name.trim()} (sin cantidad en g/ml)`);
      continue;
    }
    matched++;
    grams += (f.carbsPer100g * g) / 100;
  }
  return { grams, unknown, hasFat, matched };
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
const ARROW_RATE: Record<Arrow, number> = { up: 2.5, upRight: 1.5, flat: 0, downRight: -1.5, down: -2.5 };
const MOMENTUM_TAU_MIN = 10;

/* ------------------------------------------------------------------ */
/* Eventos del día                                                      */
/* ------------------------------------------------------------------ */

export interface InsulinEvent {
  t: number;
  units: number;
  label: string;
}
export interface CarbEvent {
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
      const c = mealCarbs(m, foods);
      const tFood = toMin(m.foodTime) ?? tIns;
      if (c.unknown.length) {
        out.issues.push({ mealId: m.injectionId, text: `${m.name}: no se han podido estimar los hidratos de ${c.unknown.join(', ')}.` });
      }
      if (c.grams > 0) {
        if (tFood === null) out.issues.push({ mealId: m.injectionId, text: `${m.name}: falta la hora de la comida.` });
        else out.carbs.push({ t: tFood, grams: c.grams, durationMin: c.hasFat ? model.carbMinFat : model.carbMin, label: m.name });
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

/** Efecto acumulado (mg/dL) de comidas e insulina en el minuto t. */
function effect(ev: DayEvents, t: number, isf: number, gPerUnit: number, model: PredictModel, until: number): number {
  const csf = isf / gPerUnit; // mg/dL por gramo
  let e = 0;
  for (const c of ev.carbs) if (c.t < until) e += csf * c.grams * carbAbsorbed(t - c.t, c.durationMin);
  for (const i of ev.insulin) if (i.t < until) e -= isf * i.units * (1 - iobFraction(t - i.t, model));
  return e;
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

export function analyzeDay(day: DayRecord, s: Settings, foods: Food[]): DayAnalysis {
  const model = sanitizeModel(s.model);
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

    const myCarbs = events.carbs.filter((c) => c.t >= t0 - 1 && c.t < horizon);
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

    // --- Curva ---
    const e0 = effect(events, t0, isf, gPerUnit, model, horizon);
    const rate = m.before.arrow ? ARROW_RATE[m.before.arrow] : 0;
    const step = 5;
    for (let t = t0; t <= horizon + 0.01; t += step) {
      const mom = rate * MOMENTUM_TAU_MIN * (1 - Math.exp(-(t - t0) / MOMENTUM_TAU_MIN));
      const g = g0 + (effect(events, t, isf, gPerUnit, model, horizon) - e0) + mom;
      ep.points.push({ t, g: Math.max(20, Math.round(g * 10) / 10) });
    }
    ep.nadir = ep.points.reduce((a, b) => (b.g < a.g ? b : a));
    ep.peak = ep.points.reduce((a, b) => (b.g > a.g ? b : a));
    ep.endG = ep.points[ep.points.length - 1]?.g ?? null;

    // --- Desviaciones frente a lo medido en este episodio ---
    for (const p of measured) {
      if (p.t <= t0 || p.t > horizon) continue;
      const pred = predictedAt(ep, p.t);
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

    // R1 · riesgo de hipoglucemia prevista
    if (ep.nadir && ep.nadir.g < 70) {
      recs.push({
        level: 'alerta',
        code: 'hipo-prevista',
        text: `Se prevé bajar a ≈${Math.round(ep.nadir.g)} mg/dL hacia las ${fmtTime(ep.nadir.t)}. Valora medir antes de esa hora y tener a mano hidratos de acción rápida, según vuestro protocolo.`,
      });
    } else if (ep.nadir && ep.nadir.g < 90 && ep.nadir.t > t0 + 20) {
      recs.push({
        level: 'atencion',
        code: 'bajada-prevista',
        text: `La previsión baja hasta ≈${Math.round(ep.nadir.g)} mg/dL hacia las ${fmtTime(ep.nadir.t)}: conviene vigilar la tendencia en ese tramo.`,
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
    const carbEstimate = mealCarbs(m, foods);
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

function predictedAt(ep: Episode, t: number): number | null {
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

