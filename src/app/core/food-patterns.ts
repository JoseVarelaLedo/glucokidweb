/**
 * Alimentos que se repiten antes de picos de glucemia (hiper o hipo).
 *
 * Cálculo puro. Para cada comida con alimentos y hora se miran las 4 h siguientes (sin pasar de la comida siguiente) y se anota si la
 * glucemia superó HIGH o bajó de LOW. Después, para cada alimento (y grupo de alimentos) se compara cómo salen las comidas que lo
 * llevan frente a las que no. Solo se señala un alimento si se repite lo bastante y la diferencia no se explica por azar:
 * es una pista para revisar con calma, no una causa demostrada.
 */
import { HIGH, LOW } from './evolution';
import { Food, DayRecord } from './models';
import { findFood, toMin } from './predict';

/** Ventana tras la comida (min) y margen inicial: la subida de la propia comida no se nota antes. */
export const WINDOW_MIN = 240;
export const SKIP_FIRST_MIN = 30;
/** Ventana mínima para poder valorar una comida (min). */
export const MIN_WINDOW = 60;
/** Veces mínimas que debe aparecer un alimento, en cuántos días distintos y con cuántos picos. */
export const MIN_APPEARANCES = 4;
export const MIN_DAYS = 3;
export const MIN_EVENTS = 3;
/** Comidas mínimas «sin ese alimento» para poder comparar. */
export const MIN_OTHERS = 4;
/** Fracción mínima de comidas con pico para señalar un alimento. */
export const MIN_RATE = 0.5;
/** z de la cota inferior de Wilson (≈ 90 % a una cola). */
const Z = 1.28;
const MAX_FINDINGS = 6;

export type Outcome = 'hiper' | 'hipo';

export interface Episode {
  date: string;
  /** Minuto en que empieza la comida. */
  t: number;
  meal: string;
  foods: Array<{ key: string; label: string }>;
  groups: string[];
  /** Hubo alguna lectura valorable en la ventana. */
  evaluable: boolean;
  hyper: boolean;
  hypo: boolean;
  /** Se puede atribuir una hiper a la comida (no había ya hiper antes de comer). */
  hyperEligible: boolean;
  /** Se puede atribuir una hipo a la comida (no había hipo antes, ni ejercicio en la ventana). */
  hypoEligible: boolean;
}

export interface FoodFinding {
  outcome: Outcome;
  scope: 'alimento' | 'grupo';
  name: string;
  /** Comidas con ese alimento valoradas, días distintos y cuántas acabaron en pico. */
  n: number;
  days: number;
  events: number;
  rate: number;
  /** Fracción de pico en las demás comidas. */
  others: number;
  text: string;
}

export interface FoodPatterns {
  findings: FoodFinding[];
  /** Comidas con alimentos que se han podido valorar. */
  episodes: number;
  days: number;
  hyper: number;
  hypo: number;
  /** Se usó la serie continua del sensor en algún día. */
  usedSensor: boolean;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

interface Pt {
  t: number;
  g: number;
}

function readingsOf(d: DayRecord): { pts: Pt[]; sensor: boolean; activities: Array<[number, number]> } {
  const pts: Pt[] = [];
  const add = (time: string | null | undefined, v: number | null | undefined) => {
    const t = toMin(time);
    if (t !== null && typeof v === 'number' && Number.isFinite(v) && v > 0) pts.push({ t, g: v });
  };
  for (const m of d.meals ?? []) {
    add(m.before?.time, m.before?.value);
    add(m.after?.time, m.after?.value);
  }
  for (const x of d.extras ?? []) add(x.time, x.value);
  for (const a of d.activities ?? []) {
    add(a.start, a.before?.value);
    add(a.end, a.after?.value);
  }
  const s = d.sensor;
  let sensor = false;
  if (Array.isArray(s)) {
    for (let i = 0; i + 1 < s.length; i += 2) {
      if (Number.isFinite(s[i]) && Number.isFinite(s[i + 1]) && s[i + 1] > 0) {
        pts.push({ t: s[i], g: s[i + 1] });
        sensor = true;
      }
    }
  }
  const activities: Array<[number, number]> = [];
  for (const a of d.activities ?? []) {
    const t0 = toMin(a.start);
    if (t0 === null) continue;
    const t1 = toMin(a.end);
    activities.push([t0, t1 !== null && t1 >= t0 ? t1 : t0 + 60]);
  }
  return { pts, sensor, activities };
}

/** Una entrada por comida con alimentos y hora. */
export function buildEpisodes(days: DayRecord[], foods: Food[]): { episodes: Episode[]; usedSensor: boolean } {
  const out: Episode[] = [];
  let usedSensor = false;
  for (const day of days) {
    const { pts, sensor, activities } = readingsOf(day);
    if (sensor) usedSensor = true;
    const starts = (day.meals ?? [])
      .map((m) => toMin(m.foodTime) ?? toMin(m.before?.time))
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b);
    for (const m of day.meals ?? []) {
      const names = (m.items ?? []).map((it) => (it.name ?? '').trim()).filter((n) => n.length >= 2);
      if (!names.length) continue;
      const t0 = toMin(m.foodTime) ?? toMin(m.before?.time);
      if (t0 === null) continue;

      const seen = new Set<string>();
      const fl: Episode['foods'] = [];
      const groups = new Set<string>();
      for (const name of names) {
        const f = findFood(name, foods);
        const label = f ? f.name : name;
        const key = norm(label);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        fl.push({ key, label });
        if (f?.group) groups.add(f.group);
      }
      if (!fl.length) continue;

      // la ventana termina en la comida siguiente (su subida ya no es de esta)
      const next = starts.find((s) => s > t0 + 5);
      const end = Math.min(t0 + WINDOW_MIN, next ?? Infinity);
      const inWin = pts.filter((p) => p.t >= t0 + SKIP_FIRST_MIN && p.t < end);
      const evaluable = end - t0 >= MIN_WINDOW && inWin.length > 0;
      const pre = m.before?.value;
      const hyperEligible = !(typeof pre === 'number' && pre > HIGH);
      const withActivity = activities.some(([a, b]) => a < end && b > t0 - 30);
      const hypoEligible = !(typeof pre === 'number' && pre < LOW) && !withActivity;
      out.push({
        date: day.date,
        t: t0,
        meal: m.name,
        foods: fl,
        groups: [...groups],
        evaluable,
        hyper: evaluable && inWin.some((p) => p.g > HIGH),
        hypo: evaluable && inWin.some((p) => p.g < LOW),
        hyperEligible,
        hypoEligible,
      });
    }
  }
  return { episodes: out, usedSensor };
}

/** Cota inferior de Wilson de una proporción (k de n). */
export function wilsonLower(k: number, n: number, z = Z): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

interface Tally {
  label: string;
  n: number;
  events: number;
  dates: Set<string>;
}

const pct = (x: number): string => `${Math.round(x * 100)} %`;

function analyze(episodes: Episode[], outcome: Outcome, scope: 'alimento' | 'grupo'): FoodFinding[] {
  const eligible = episodes.filter((e) => e.evaluable && (outcome === 'hiper' ? e.hyperEligible : e.hypoEligible));
  const hit = (e: Episode) => (outcome === 'hiper' ? e.hyper : e.hypo);
  const N = eligible.length;
  const H = eligible.filter(hit).length;
  const tally = new Map<string, Tally>();
  for (const e of eligible) {
    const items = scope === 'alimento' ? e.foods : e.groups.map((g) => ({ key: norm(g), label: g }));
    for (const it of items) {
      const t = tally.get(it.key) ?? { label: it.label, n: 0, events: 0, dates: new Set<string>() };
      t.n++;
      if (hit(e)) t.events++;
      t.dates.add(e.date);
      tally.set(it.key, t);
    }
  }
  const out: FoodFinding[] = [];
  for (const [, t] of tally) {
    if (t.n < MIN_APPEARANCES || t.dates.size < MIN_DAYS || t.events < MIN_EVENTS) continue;
    if (N - t.n < MIN_OTHERS) continue;
    const rate = t.events / t.n;
    const others = (H - t.events) / (N - t.n);
    if (rate < MIN_RATE || wilsonLower(t.events, t.n) <= others) continue;
    const what = outcome === 'hiper' ? `superó ${HIGH} mg/dL` : `bajó de ${LOW} mg/dL`;
    const lead = scope === 'grupo' ? `Grupo «${t.label}»` : `«${t.label}»`;
    out.push({
      outcome,
      scope,
      name: t.label,
      n: t.n,
      days: t.dates.size,
      events: t.events,
      rate,
      others,
      text:
        `${lead} está en ${t.n} comidas de ${t.dates.size} días y en ${t.events} de ellas (${pct(rate)}) la glucemia ${what} en las 4 h siguientes, ` +
        `frente al ${pct(others)} de las demás comidas. ` +
        (outcome === 'hiper'
          ? 'Puede influir la cantidad, con qué se combina o la dosis: conviene revisarlo con el equipo médico.'
          : 'Puede influir la cantidad o la dosis: conviene revisarlo con el equipo médico y tener a mano hidratos rápidos.'),
    });
  }
  // los más claros primero (cota inferior de la proporción)
  return out.sort((a, b) => wilsonLower(b.events, b.n) - wilsonLower(a.events, a.n) || b.n - a.n);
}

export function foodPatterns(days: DayRecord[], foods: Food[]): FoodPatterns {
  const { episodes, usedSensor } = buildEpisodes(days, foods);
  const ev = episodes.filter((e) => e.evaluable);
  const food = [...analyze(episodes, 'hipo', 'alimento'), ...analyze(episodes, 'hiper', 'alimento')];
  // de los grupos, como mucho dos (los alimentos concretos son más útiles)
  const groups = [...analyze(episodes, 'hipo', 'grupo'), ...analyze(episodes, 'hiper', 'grupo')]
    // si un único alimento ya explica el grupo (mismas comidas y picos), no se repite
    .filter((g) => !food.some((f) => f.outcome === g.outcome && f.n === g.n && f.events === g.events))
    .slice(0, 2);
  const findings = [...food.slice(0, MAX_FINDINGS), ...groups];
  return {
    findings,
    episodes: ev.length,
    days: new Set(ev.map((e) => e.date)).size,
    hyper: ev.filter((e) => e.hyper).length,
    hypo: ev.filter((e) => e.hypo).length,
    usedSensor,
  };
}
