/**
 * Sugerencia (solo informativa) de la hora a la que empezar a comer tras inyectar la rápida.
 *
 * Se parte de lo que se sabe en el momento de la inyección: la glucemia y su flecha, la insulina de la comida que se acaba de poner, la insulina aún
 * activa de dosis anteriores (cuánto hace de la última), los hidratos de la comida anterior que aún se absorben (cuánto hace de ella) y las raciones de esta comida.
 * Con el modelo ya ajustado a las curvas del sensor de este niño (ver `model-fit.ts`) se simula la glucemia para cada espera posible (0, 5, 10… min)
 * y se propone la que deja la curva prevista más tiempo dentro de rango, penalizando más las bajadas que las subidas.
 *
 * Lo aprendido es: el ajuste del modelo por franjas del día (sensibilidad), la espera máxima que esta familia usa de verdad (nunca se propone una espera
 * mucho mayor que la habitual) y, como contraste, lo que ha pasado en las comidas con espera frente a las comidas sin ella.
 * Solo se ofrece cuando hay datos suficientes (ver `waitGate`). No cambia ninguna dosis ni ningún cálculo.
 */
import { Arrow, DayRecord, Food, Meal, Settings } from './models';
import { ModelFit, analyzeDay, carbAbsorbed, dayEvents, fmtTime, iobAt, planCarbs, sensorPoints, toMin } from './predict';

export const WAIT_STEP = 5;
export const WAIT_MAX = 30; // min: tope absoluto de lo que se sugiere
export const WAIT_DEFAULT_CAP = 20; // min: tope mientras no hay suficientes esperas anotadas
export const WAIT_MIN_EPISODES = 20; // comidas con curva del sensor con las que se ha ajustado el modelo
export const WAIT_HORIZON = 240; // min de curva que se valoran
const CAP_MIN_SAMPLES = 5;
const EVIDENCE_MIN = 6; // comidas por grupo para contrastar
const EVIDENCE_SPLIT = 10; // min: «con espera» frente a «sin espera»
const HIGH = 180;
const LOW_SOFT = 80;
const LOW_HARD = 70;

const ARROW: Record<Arrow, string> = { up: '↑', upRight: '↗', flat: '→', downRight: '↘', down: '↓' };

export interface WaitStats {
  /** Espera máxima que se sugiere (min), aprendida de las esperas anotadas. */
  cap: number;
  /** Comidas con espera anotada. */
  n: number;
  /** Contraste con lo ocurrido en las comidas del historial (null si no hay datos para compararlo). */
  evidence: string | null;
}

export type WaitAdvice =
  | { ok: true; wait: number; foodAt: string; head: string; detail: string; evidence: string | null }
  | { ok: false; reason: string };

const median = (a: number[]): number => {
  const v = [...a].sort((x, y) => x - y);
  const n = v.length;
  return n === 0 ? 0 : n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
};

const fmtN = (n: number, d = 1): string => n.toLocaleString('es-ES', { maximumFractionDigits: d });

function fmtDur(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Esperas reales (min entre la inyección y el inicio de la comida) y lo que subió la glucemia después, según el sensor. */
export function waitStats(days: DayRecord[]): WaitStats {
  const waits: number[] = [];
  const noWait: number[] = [];
  const withWait: number[] = [];
  for (const day of days) {
    const sp = sensorPoints(day.sensor);
    for (const m of day.meals) {
      if (m.kind !== 'rapida' || (m.before.units ?? 0) <= 0) continue;
      const ti = toMin(m.before.time);
      const tf = toMin(m.foodTime);
      if (ti === null || tf === null) continue;
      const w = tf - ti;
      if (w < 0 || w > 60) continue;
      waits.push(w);
      const g0 = m.before.value;
      if (g0 === null || g0 === undefined || sp.length < 20) continue;
      const win = sp.filter((p) => p.t >= ti + 30 && p.t <= ti + 180);
      if (win.length < 12) continue;
      const rise = Math.max(...win.map((p) => p.g)) - g0;
      (w >= EVIDENCE_SPLIT ? withWait : noWait).push(rise);
    }
  }
  let cap = WAIT_DEFAULT_CAP;
  if (waits.length >= CAP_MIN_SAMPLES) {
    const v = [...waits].sort((a, b) => a - b);
    const p90 = v[Math.min(v.length - 1, Math.floor(0.9 * v.length))];
    cap = Math.min(WAIT_MAX, Math.max(10, Math.round(p90 / WAIT_STEP) * WAIT_STEP));
  }
  let evidence: string | null = null;
  if (noWait.length >= EVIDENCE_MIN && withWait.length >= EVIDENCE_MIN) {
    const a = median(noWait);
    const b = median(withWait);
    evidence =
      `En vuestras comidas, tras inyectar la glucemia subió una mediana de ${fmtN(b, 0)} mg/dL cuando se esperó ${EVIDENCE_SPLIT} min o más (${withWait.length} comidas) ` +
      `y de ${fmtN(a, 0)} mg/dL cuando se esperó menos (${noWait.length} comidas). Es solo una comparación: influyen también la glucemia de partida, la comida y la dosis.`;
  }
  return { cap, n: waits.length, evidence };
}

/** ¿Hay datos suficientes para sugerir? (modelo ajustado con suficientes comidas y previsión evaluada con un error razonable). */
export function waitGate(fit: ModelFit, bands: { ready: boolean; wide: boolean; have: number; needed: number } | null): { ok: boolean; why: string } {
  const miss: string[] = [];
  if (!fit.active || fit.episodes < WAIT_MIN_EPISODES) miss.push(`comidas con curva del sensor con las que se ha ajustado el modelo: ${fit.episodes} de ${WAIT_MIN_EPISODES}`);
  if (!bands || !bands.ready) miss.push(`comparaciones previsto-real: ${bands?.have ?? 0} de ${bands?.needed ?? 20}`);
  else if (bands.wide) miss.push('la previsión todavía es poco fiable (margen de error muy ancho)');
  return { ok: miss.length === 0, why: miss.join('; ') };
}

/** Puntuación de una curva (menor es mejor): mg/dL·h fuera de rango, contando más las bajadas que las subidas. */
function risk(points: Array<{ t: number; g: number }>, t0: number): number {
  let s = 0;
  for (const p of points) {
    if (p.t - t0 > WAIT_HORIZON) break;
    s += Math.max(0, p.g - HIGH) + 3 * Math.max(0, LOW_SOFT - p.g) + 6 * Math.max(0, LOW_HARD - p.g);
  }
  return (s * 5) / 60;
}

export function adviseWait(day: DayRecord, meal: Meal, s: Settings, foods: Food[], fit: ModelFit, stats: WaitStats): WaitAdvice {
  const t0 = toMin(meal.before.time);
  const g0 = meal.before.value;
  const units = meal.before.units ?? 0;
  if (meal.kind !== 'rapida' || t0 === null || g0 === null || g0 === undefined || units <= 0) return { ok: false, reason: 'faltan la hora, la glucemia o la dosis de esta comida' };
  if (g0 < 70) return { ok: false, reason: `la glucemia es ${Math.round(g0)} mg/dL (hipoglucemia): sigue el protocolo de vuestro equipo médico; no se sugiere hora` };

  // hidratos de la comida: los anotados o, si todavía no hay, las raciones previstas en Ajustes
  const hasItems = meal.items.some((i) => i.name?.trim() && typeof i.rations === 'number' && i.rations > 0);
  let usedPlan = false;
  let base: DayRecord = day;
  if (!hasItems) {
    const planned = planCarbs(s.injections.find((i) => i.id === meal.injectionId)?.plan);
    if (!(planned > 0)) return { ok: false, reason: 'no hay raciones de hidratos anotadas ni previstas para esta comida' };
    usedPlan = true;
    const item = { id: 'wait-plan', name: 'Raciones previstas', quantity: '', rations: planned };
    base = { ...day, meals: day.meals.map((x) => (x === meal ? { ...x, items: [item] } : x)) } as DayRecord;
  }
  const mealOf = (d: DayRecord): Meal => d.meals.find((x) => x.injectionId === meal.injectionId) as Meal;

  // contexto: insulina activa y comida anterior
  const ev = dayEvents(base, s, foods);
  const iob = iobAt(ev, t0, s, t0);
  const prevIns = ev.insulin.filter((i) => i.t < t0).reduce((a, i) => Math.max(a, i.t), -1);
  const prevMeals = ev.carbs.filter((c) => c.mealId !== meal.injectionId && c.t < t0);
  const cob = prevMeals.reduce((a, c) => a + c.grams * (1 - carbAbsorbed(t0 - c.t, c.durationMin)), 0);
  const prevMeal = prevMeals.reduce((a, c) => Math.max(a, c.t), -1);
  const arrow = meal.before.arrow;

  const curve = (w: number): Array<{ t: number; g: number }> | null => {
    const clone: DayRecord = { ...base, meals: base.meals.map((x) => (x.injectionId === meal.injectionId ? { ...x, foodTime: fmtTime(t0 + w) } : x)) };
    const ep = analyzeDay(clone, s, foods, fit, null).episodes.find((e) => e.mealId === meal.injectionId);
    return ep && ep.points.length > 1 ? ep.points : null;
  };
  void mealOf;

  // reglas de seguridad: con la glucemia baja o bajando no se espera
  const falling = arrow === 'down' || arrow === 'downRight';
  const rule = g0 < 90 || (falling && g0 < 150);
  let wait = 0;
  let pk0: number | null = null;
  let pkW: number | null = null;
  let mnW: number | null = null;
  const cap = Math.min(WAIT_MAX, stats.cap);
  if (!rule) {
    const results: Array<{ w: number; r: number; pts: Array<{ t: number; g: number }> }> = [];
    for (let w = 0; w <= cap; w += WAIT_STEP) {
      const pts = curve(w);
      if (!pts) return { ok: false, reason: 'con los datos anotados el modelo no da una previsión creíble para esta comida (revisa dosis, raciones y horas)' };
      results.push({ w, r: risk(pts, t0), pts });
    }
    const best = Math.min(...results.map((x) => x.r));
    const pick = results.find((x) => x.r <= best * 1.03 + 0.5) ?? results[0]; // a igualdad, la espera más corta
    wait = pick.w;
    const peak = (p: Array<{ t: number; g: number }>) => Math.max(...p.filter((x) => x.t - t0 <= WAIT_HORIZON).map((x) => x.g));
    const low = (p: Array<{ t: number; g: number }>) => Math.min(...p.filter((x) => x.t - t0 <= WAIT_HORIZON).map((x) => x.g));
    pk0 = peak(results[0].pts);
    pkW = peak(pick.pts);
    mnW = low(pick.pts);
  }

  const foodAt = fmtTime(t0 + wait);
  const head =
    `De acuerdo a los datos aprendidos, la hora recomendada para empezar a comer es ${foodAt} ` +
    (wait === 0 ? '(ahora, justo al inyectar).' : `(una espera de ${wait} min tras inyectar a las ${fmtTime(t0)}).`);

  const parts: string[] = [`glucemia ${Math.round(g0)} mg/dL${arrow ? ' ' + ARROW[arrow] : ''}`];
  parts.push(iob >= 0.1 ? `≈ ${fmtN(iob)} U de rápida aún activas (la última dosis, hace ${fmtDur(t0 - prevIns)})` : 'sin insulina rápida previa activa');
  parts.push(cob >= 5 ? `≈ ${Math.round(cob)} g de la comida anterior sin absorber (hace ${fmtDur(t0 - prevMeal)})` : 'sin hidratos pendientes de la comida anterior');
  parts.push(usedPlan ? 'las raciones previstas en Ajustes (aún no hay raciones anotadas)' : 'las raciones anotadas');
  let detail = `Se ha tenido en cuenta: ${parts.join('; ')}. `;
  if (rule) detail += 'Con la glucemia baja o bajando conviene no esperar.';
  else if (wait > 0 && pk0 !== null && pkW !== null && mnW !== null)
    detail += `Según el modelo, empezando a comer ya el pico sería ≈ ${Math.round(pk0)} mg/dL y con esa espera ≈ ${Math.round(pkW)} mg/dL, sin bajar de ≈ ${Math.round(mnW)} mg/dL.`;
  else if (pkW !== null && mnW !== null) detail += `Según el modelo, esperar no mejora la curva prevista (pico ≈ ${Math.round(pkW)} mg/dL, mínimo ≈ ${Math.round(mnW)} mg/dL).`;
  return { ok: true, wait, foodAt, head, detail, evidence: stats.evidence };
}
