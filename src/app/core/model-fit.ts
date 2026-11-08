/**
 * Ajuste del modelo predictivo con las curvas reales del sensor.
 *
 * El modelo parte de dos números de Ajustes (factor de sensibilidad y relación raciones/unidades) que, si salen de reglas generales
 * (1700 ÷ dosis diaria, 500 ÷ dosis diaria) pueden estar lejos de cómo responde de verdad el niño, sobre todo con dosis diarias pequeñas.
 * Aquí se compara lo que el modelo habría previsto con lo que midió el sensor tras cada comida y se calculan dos factores:
 *
 *     G(t) − G0 ≈ a · (efecto de los hidratos) − b · (efecto de la insulina)
 *
 * `a` y `b` se estiman por mínimos cuadrados con dos salvaguardas: se tiran hacia 1 (con poca información manda lo configurado) y se
 * limitan a [0,25 ; 1,6]. Los valores atípicos pesan menos. Solo se activa si hay suficientes comidas con curva del sensor y si el ajuste
 * reduce de verdad el error. NO cambia Ajustes: solo corrige la previsión.
 */
import { Arrow, DayRecord, Food, Meal, Settings } from './models';
import { ARROW_RATE, MOMENTUM_TAU_MIN, ModelFit, NO_FIT, SLOTS, Slot, SlotFit, dayEvents, effectParts, fitKey, iobAt, sanitizeModel, sensorPoints, slotOf, toMin } from './predict';

export const FIT_MIN_EPISODES = 5;
export const FIT_MIN_POINTS = 25;
export const FIT_MIN_GAIN = 0.03; // el error debe bajar al menos un 3 %
export const FIT_PRIOR_N = 6; // «observaciones» que pesa la configuración actual frente a los datos
export const SLOT_PRIOR_N = 8; // idem, para una franja frente al ajuste general
export const SLOT_MIN_EPISODES = 4;
export const FIT_LIMITS: [number, number] = [0.25, 1.6];
const GRID_STEP = 20;
const GRID_FIRST = 20;
const NEAR_MIN = 7; // la lectura del sensor debe estar a ≤ 7 min del instante

export interface Obs {
  ep: string; // comida a la que pertenece (para la validación cruzada)
  slot: Slot;
  x1: number; // efecto de los hidratos (mg/dL), sin ajustar
  x2: number; // −efecto de la insulina (mg/dL), sin ajustar
  y: number; // lo que cambió de verdad respecto al ancla, quitada la inercia de la flecha
}

function nearest(pts: Array<{ t: number; g: number }>, t: number): number | null {
  let best: number | null = null;
  let bd = NEAR_MIN + 0.001;
  for (const p of pts) {
    const d = Math.abs(p.t - t);
    if (d < bd) {
      bd = d;
      best = p.g;
    }
  }
  return best;
}

function exerciseNear(day: DayRecord, t0: number, tEnd: number): boolean {
  for (const a of day.activities ?? []) {
    const s = toMin(a.start);
    const e = toMin(a.end) ?? s;
    if (s === null || e === null) continue;
    if ((e <= t0 && t0 - e <= 360) || (s < tEnd && e >= t0)) return true;
  }
  return false;
}

/** Observaciones (una por instante de la cuadrícula con lectura del sensor) de todas las comidas con curva continua. */
export function collectObs(days: DayRecord[], s: Settings, foods: Food[]): { obs: Obs[]; episodes: number } {
  const model = sanitizeModel(s.model);
  const isf = s.isf && s.isf > 0 ? s.isf : 0;
  const gpr = s.gramsPerRation > 0 ? s.gramsPerRation : 10;
  const upr = s.unitsPerRation > 0 ? s.unitsPerRation : 1;
  const gPerUnit = gpr / upr;
  const obs: Obs[] = [];
  let episodes = 0;
  if (!isf) return { obs, episodes };

  for (const day of days) {
    const sp = sensorPoints(day.sensor);
    if (sp.length < 20) continue;
    const ev = dayEvents(day, s, foods);
    const anchors = day.meals
      .filter((m: Meal) => m.kind === 'rapida')
      .map((m) => ({ m, t0: toMin(m.before.time), g0: m.before.value }))
      .filter((a): a is { m: Meal; t0: number; g0: number } => a.t0 !== null && a.g0 !== null && a.g0 !== undefined)
      .sort((a, b) => a.t0 - b.t0);

    for (let k = 0; k < anchors.length; k++) {
      const { m, t0, g0 } = anchors[k];
      const nextT = k + 1 < anchors.length ? anchors[k + 1].t0 : Infinity;
      const horizon = Math.min(t0 + model.diaMin, nextT);
      if (g0 < 70) continue;
      const myCarbs = ev.carbs.filter((c) => c.t >= t0 - 1 && c.t < horizon);
      const myIns = ev.insulin.filter((i) => i.t >= t0 - 1 && i.t < horizon);
      if (!myCarbs.length && !myIns.length) continue;
      // datos que no se pueden interpretar: hidratos sin dosis anotada, ejercicio, comidas sin hora
      if (myCarbs.length && !myIns.length && m.before.units == null) continue;
      if (ev.issues.some((i) => i.mealId === m.injectionId)) continue;
      if (exerciseNear(day, t0, horizon)) continue;
      if (iobAt(ev, t0, s, t0 - 1) > 2) continue; // mucha insulina de antes: demasiado confuso
      const rate = m.before.arrow ? ARROW_RATE[m.before.arrow as Arrow] : 0;
      const p0 = effectParts(ev, t0, isf, gPerUnit, model, horizon);
      let used = 0;
      for (let t = t0 + GRID_FIRST; t <= horizon + 0.01; t += GRID_STEP) {
        const gs = nearest(sp, t);
        if (gs === null) continue;
        const p = effectParts(ev, t, isf, gPerUnit, model, horizon);
        const mom = rate * MOMENTUM_TAU_MIN * (1 - Math.exp(-(t - t0) / MOMENTUM_TAU_MIN));
        obs.push({ ep: `${day.date}|${m.injectionId}`, slot: slotOf(t0), x1: p.c - p0.c, x2: -(p.i - p0.i), y: gs - g0 - mom });
        used++;
      }
      if (used >= 3) episodes++;
      else obs.length -= used;
    }
  }
  return { obs, episodes };
}

function rmse(obs: Obs[], a: number, b: number): number {
  if (!obs.length) return 0;
  let s2 = 0;
  for (const o of obs) s2 += (o.y - (a * o.x1 + b * o.x2)) ** 2;
  return Math.sqrt(s2 / obs.length);
}

/** Mínimos cuadrados con pesos de Huber y atracción hacia `center` (por defecto, la configuración de Ajustes: 1, 1). */
export function solve(obs: Obs[], center: { a: number; b: number } = { a: 1, b: 1 }, priorN: number = FIT_PRIOR_N): { a: number; b: number } {
  const n = obs.length;
  if (!n) return { ...center };
  const m1 = obs.reduce((t, o) => t + o.x1 * o.x1, 0) / n;
  const m2 = obs.reduce((t, o) => t + o.x2 * o.x2, 0) / n;
  const l1 = priorN * m1;
  const l2 = priorN * m2;
  let a = center.a;
  let b = center.b;
  for (let it = 0; it < 4; it++) {
    let s11 = l1;
    let s22 = l2;
    let s12 = 0;
    let r1 = l1 * center.a;
    let r2 = l2 * center.b;
    for (const o of obs) {
      const res = Math.abs(o.y - (a * o.x1 + b * o.x2));
      const w = res > 40 ? 40 / res : 1;
      s11 += w * o.x1 * o.x1;
      s22 += w * o.x2 * o.x2;
      s12 += w * o.x1 * o.x2;
      r1 += w * o.x1 * o.y;
      r2 += w * o.x2 * o.y;
    }
    const det = s11 * s22 - s12 * s12;
    if (!(Math.abs(det) > 1e-9)) break;
    a = (r1 * s22 - s12 * r2) / det;
    b = (s11 * r2 - s12 * r1) / det;
    a = Math.min(FIT_LIMITS[1], Math.max(FIT_LIMITS[0], a));
    b = Math.min(FIT_LIMITS[1], Math.max(FIT_LIMITS[0], b));
  }
  return { a, b };
}

/** Error (RMSE) de validación cruzada «dejando una comida fuera»: se ajusta sin ella y se mide en ella. */
export function cvRmse(obs: Obs[], center: { a: number; b: number }, priorN: number): number {
  if (!obs.length) return 0;
  const ids = [...new Set(obs.map((o) => o.ep))];
  let s2 = 0;
  for (const id of ids) {
    const train = obs.filter((o) => o.ep !== id);
    const { a, b } = solve(train, center, priorN);
    for (const o of obs) if (o.ep === id) s2 += (o.y - (a * o.x1 + b * o.x2)) ** 2;
  }
  return Math.sqrt(s2 / obs.length);
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function fitModel(days: DayRecord[], s: Settings, foods: Food[]): ModelFit {
  const key = fitKey(s);
  const { obs, episodes } = collectObs(days, s, foods);
  if (episodes < FIT_MIN_EPISODES || obs.length < FIT_MIN_POINTS) return { ...NO_FIT, key, episodes, points: obs.length, slots: {} };

  // 1) ajuste general
  const g = solve(obs);
  const before = rmse(obs, 1, 1);
  const cv = cvRmse(obs, { a: 1, b: 1 }, FIT_PRIOR_N);
  const active = before > 0 && 1 - cv / before >= FIT_MIN_GAIN;
  const ga = active ? g.a : 1;
  const gb = active ? g.b : 1;

  // 2) ajuste por franja del día, atraído hacia el general; solo si mejora al general en validación cruzada
  const slots: Partial<Record<Slot, SlotFit>> = {};
  for (const sl of SLOTS) {
    const o = obs.filter((x) => x.slot === sl.id);
    const eps = new Set(o.map((x) => x.ep)).size;
    if (eps < SLOT_MIN_EPISODES) {
      slots[sl.id] = { active: false, a: r2(ga), b: r2(gb), episodes: eps, points: o.length, rmseBefore: null, rmseAfter: null };
      continue;
    }
    const base = rmse(o, ga, gb);
    const cvS = cvRmse(o, { a: ga, b: gb }, SLOT_PRIOR_N);
    const fa = solve(o, { a: ga, b: gb }, SLOT_PRIOR_N);
    slots[sl.id] = {
      active: base > 0 && 1 - cvS / base >= FIT_MIN_GAIN,
      a: r2(fa.a),
      b: r2(fa.b),
      episodes: eps,
      points: o.length,
      rmseBefore: Math.round(base),
      rmseAfter: Math.round(cvS),
    };
  }
  return { active, a: r2(g.a), b: r2(g.b), episodes, points: obs.length, key, rmseBefore: Math.round(before), rmseAfter: Math.round(cv), slots };
}
