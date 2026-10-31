import { analyzeDay, toMin } from './predict';
import { Arrow, DayRecord, Food, Settings } from './models';
import { strToDate } from './util';

/**
 * Fiabilidad del monitor frente a las glucemias capilares.
 *
 * Idea: cada capilar con una lectura del monitor muy cercana en el tiempo forma un PAR. De los pares se aprende, con
 * estadística robusta y prudente, cuánto y en qué condiciones difiere el monitor del capilar (nivel de glucemia, flecha de
 * tendencia, día de vida del sensor). El aprendizaje se VALIDA contra los datos que aún no había visto («walk-forward»)
 * y solo se muestran avisos en las lecturas cuando esa validación demuestra una mejora real.
 *
 * El modelo predictivo de insulina e hidratos NO se usa como verdad: solo se contrasta, para ver con qué fiabilidad coincide.
 * Todo es informativo: no sustituye al capilar ni a la valoración del equipo médico.
 */

/* ---------------- parámetros (prudentes a propósito) ---------------- */

/** Máxima separación en minutos entre un capilar y la lectura del monitor con la que se empareja. */
export const PAIR_MAX_GAP_MIN = 10;
/** Días hacia atrás que se usan para aprender (el sensor, el niño y su pauta cambian con el tiempo). */
export const WINDOW_DAYS = 180;
/** Pares mínimos para empezar a estimar nada. */
export const MIN_PAIRS = 25;
/** Pares mínimos para poder dar un aviso en las lecturas. */
export const MIN_RELIABLE = 50;
/** Pares «futuros» mínimos sobre los que se comprueba el aprendizaje. */
export const MIN_BACKTEST = 20;
/** Mejora mínima del error medio (frente al monitor sin corregir) para considerar fiable la corrección. */
export const MIN_IMPROVEMENT = 0.1;
/** Pares mínimos para enseñar el sesgo de un subgrupo (zona, flecha, día de sensor). */
export const MIN_GROUP = 15;
/** Diferencia mínima (mg/dL) que merece un aviso. */
export const MIN_RELEVANT_DIFF = 6;
/** Fuerza con la que cada factor se acerca a «cero» cuando tiene pocos datos (equivale a K pares ficticios sin sesgo). */
const SHRINK_K = 10;
/** Un sensor dura como mucho ~15 días: pasado ese tiempo se asume que no se anotó el cambio. */
export const MAX_SENSOR_DAYS = 16;

/* ---------------- tipos ---------------- */

export type Zone = 'baja' | 'rango' | 'alta';
export type ArrowGroup = 'estable' | 'sube' | 'baja' | 'sin';
export type SensorBand = 'inicio' | 'medio' | 'final' | 'sin';

export const ZONE_LABEL: Record<Zone, string> = { baja: 'Monitor por debajo de 80', rango: 'Monitor entre 80 y 180', alta: 'Monitor por encima de 180' };
export const ARROW_LABEL: Record<ArrowGroup, string> = { estable: 'Estable (→)', sube: 'Subiendo (↑ ↗)', baja: 'Bajando (↓ ↘)', sin: 'Sin flecha' };
export const BAND_LABEL: Record<SensorBand, string> = {
  inicio: 'Sensor: días 1–2',
  medio: 'Sensor: días 3–9',
  final: 'Sensor: día 10 en adelante',
  sin: 'Sensor sin anotar',
};

export interface Context {
  zone: Zone;
  arrow: ArrowGroup;
  band: SensorBand;
}

export interface Pair extends Context {
  date: string;
  t: number; // minuto del día del capilar
  cap: number;
  mon: number;
  /** monitor − capilar (positivo: el monitor marca de más). */
  diff: number;
  gap: number; // minutos entre ambas mediciones
  arrowRaw: Arrow | null;
  sensorDay: number | null;
  /** Valor que el modelo predictivo esperaba en ese momento (si lo cubría). */
  pred?: number | null;
}

/* ---------------- sensor ---------------- */

export function daysBetween(a: string, b: string): number {
  return Math.round((strToDate(b).getTime() - strToDate(a).getTime()) / 86400000);
}

/** Día de vida del sensor en una fecha (1 = día del cambio), o null si no se conoce. */
export function sensorDayOf(date: string, changes: readonly string[] | undefined): number | null {
  let last: string | null = null;
  for (const c of changes ?? []) if (c <= date && (last === null || c > last)) last = c;
  if (last === null) return null;
  const d = daysBetween(last, date) + 1;
  return d <= MAX_SENSOR_DAYS ? d : null;
}

export const bandOf = (day: number | null): SensorBand => (day === null ? 'sin' : day <= 2 ? 'inicio' : day <= 9 ? 'medio' : 'final');
export const zoneOf = (monitor: number): Zone => (monitor < 80 ? 'baja' : monitor <= 180 ? 'rango' : 'alta');
export const arrowGroupOf = (a: Arrow | null | undefined): ArrowGroup =>
  !a ? 'sin' : a === 'flat' ? 'estable' : a === 'up' || a === 'upRight' ? 'sube' : 'baja';

export function contextOf(value: number, arrow: Arrow | null | undefined, date: string, sensors: readonly string[] | undefined): Context {
  return { zone: zoneOf(value), arrow: arrowGroupOf(arrow), band: bandOf(sensorDayOf(date, sensors)) };
}

/* ---------------- estadística robusta ---------------- */

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Desviación típica robusta (MAD escalada). */
export function robustSd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/* ---------------- pares ---------------- */

interface Pt {
  t: number;
  v: number;
  arrow: Arrow | null;
}

function dayPoints(d: DayRecord): { mon: Pt[]; cap: Pt[] } {
  const mon: Pt[] = [];
  const cap: Pt[] = [];
  const add = (list: Pt[], time: string | null | undefined, v: number | null | undefined, arrow: Arrow | null | undefined) => {
    const t = toMin(time);
    if (t !== null && typeof v === 'number' && Number.isFinite(v) && v > 0) list.push({ t, v, arrow: arrow ?? null });
  };
  for (const m of d.meals ?? []) {
    add(mon, m.before?.time, m.before?.value, m.before?.arrow);
    add(mon, m.after?.time, m.after?.value, m.after?.arrow);
  }
  for (const x of d.extras ?? []) add(x.source === 'capilar' ? cap : mon, x.time, x.value, x.arrow);
  for (const a of d.activities ?? []) {
    add(mon, a.start, a.before?.value, a.before?.arrow);
    add(mon, a.end, a.after?.value, a.after?.arrow);
  }
  return { mon, cap };
}

/** Empareja cada capilar con la lectura del monitor más cercana (como mucho a PAIR_MAX_GAP_MIN minutos; cada una se usa una vez). */
export function collectPairs(days: DayRecord[], sensors: readonly string[] | undefined): Pair[] {
  const out: Pair[] = [];
  for (const d of days) {
    const { mon, cap } = dayPoints(d);
    if (!mon.length || !cap.length) continue;
    const used = new Set<number>();
    // primero los emparejamientos más cercanos
    const cands: Array<{ ci: number; mi: number; gap: number }> = [];
    cap.forEach((c, ci) => mon.forEach((m, mi) => {
      const gap = Math.abs(c.t - m.t);
      if (gap <= PAIR_MAX_GAP_MIN) cands.push({ ci, mi, gap });
    }));
    cands.sort((a, b) => a.gap - b.gap);
    const doneCap = new Set<number>();
    for (const k of cands) {
      if (doneCap.has(k.ci) || used.has(k.mi)) continue;
      doneCap.add(k.ci);
      used.add(k.mi);
      const c = cap[k.ci];
      const m = mon[k.mi];
      const sd = sensorDayOf(d.date, sensors);
      out.push({
        date: d.date,
        t: c.t,
        cap: c.v,
        mon: m.v,
        diff: m.v - c.v,
        gap: k.gap,
        arrowRaw: m.arrow,
        sensorDay: sd,
        zone: zoneOf(m.v),
        arrow: arrowGroupOf(m.arrow),
        band: bandOf(sd),
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.t - b.t);
}

/** Añade a cada par lo que el modelo predictivo esperaba en ese momento (solo para contrastar; no se usa para corregir). */
export function attachPredictions(pairs: Pair[], days: DayRecord[], s: Settings, foods: Food[]): void {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const cache = new Map<string, ReturnType<typeof analyzeDay> | null>();
  for (const p of pairs) {
    let a = cache.get(p.date);
    if (a === undefined) {
      const d = byDate.get(p.date);
      try {
        a = d ? analyzeDay(d, s, foods) : null;
      } catch {
        a = null;
      }
      cache.set(p.date, a);
    }
    p.pred = null;
    if (!a) continue;
    for (const e of a.episodes) {
      const pts = e.points;
      if (pts.length < 2 || p.t < pts[0].t || p.t > pts[pts.length - 1].t) continue;
      for (let i = 1; i < pts.length; i++) {
        if (p.t <= pts[i].t) {
          const a0 = pts[i - 1];
          const a1 = pts[i];
          const f = a1.t === a0.t ? 0 : (p.t - a0.t) / (a1.t - a0.t);
          p.pred = a0.g + (a1.g - a0.g) * f;
          break;
        }
      }
      if (p.pred !== null) break;
    }
  }
}

/* ---------------- ajuste del sesgo (aditivo, con contracción) ---------------- */

export interface Fit {
  n: number;
  /** Sesgo general (monitor − capilar). */
  mu: number;
  zone: Record<Zone, number>;
  arrow: Record<ArrowGroup, number>;
  band: Record<SensorBand, number>;
  /** Dispersión robusta de lo que queda sin explicar (mg/dL). */
  sd: number;
}

const ZONES: Zone[] = ['baja', 'rango', 'alta'];
const ARROWS_G: ArrowGroup[] = ['estable', 'sube', 'baja', 'sin'];
const BANDS: SensorBand[] = ['inicio', 'medio', 'final', 'sin'];

const zeros = <K extends string>(keys: K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export const biasFor = (f: Fit, c: Context): number => f.mu + f.zone[c.zone] + f.arrow[c.arrow] + f.band[c.band];

/**
 * Modelo aditivo: sesgo = general + efecto de la zona + efecto de la flecha + efecto del día de sensor.
 * Cada efecto se «contrae» hacia 0 cuanto menos datos tiene (como si hubiera K pares sin sesgo), así un subgrupo con
 * pocos pares casi no mueve la estimación. Las diferencias extremas se recortan para que un dato mal anotado no la tuerza.
 */
export function fitBias(pairs: Pair[]): Fit {
  const n = pairs.length;
  const fit: Fit = { n, mu: 0, zone: zeros(ZONES), arrow: zeros(ARROWS_G), band: zeros(BANDS), sd: 0 };
  if (!n) return fit;
  const diffs = pairs.map((p) => p.diff);
  const med = median(diffs);
  const scale = Math.max(5, robustSd(diffs));
  const y = diffs.map((d) => Math.min(med + 3 * scale, Math.max(med - 3 * scale, d)));
  fit.mu = med;
  for (let it = 0; it < 15; it++) {
    const upd = <K extends string>(eff: Record<K, number>, keys: K[], key: (p: Pair) => K): void => {
      for (const k of keys) {
        let sum = 0;
        let cnt = 0;
        pairs.forEach((p, i) => {
          if (key(p) !== k) return;
          sum += y[i] - fit.mu - biasOthers(p, eff);
          cnt++;
        });
        eff[k] = cnt ? sum / (cnt + SHRINK_K) : 0;
      }
    };
    // «otros» = suma de los efectos de los demás factores
    const biasOthers = (p: Pair, self: Record<string, number>): number =>
      (self === fit.zone ? 0 : fit.zone[p.zone]) + (self === fit.arrow ? 0 : fit.arrow[p.arrow]) + (self === fit.band ? 0 : fit.band[p.band]);
    upd(fit.zone, ZONES, (p) => p.zone);
    upd(fit.arrow, ARROWS_G, (p) => p.arrow);
    upd(fit.band, BANDS, (p) => p.band);
    fit.mu = mean(pairs.map((p, i) => y[i] - fit.zone[p.zone] - fit.arrow[p.arrow] - fit.band[p.band]));
  }
  fit.sd = robustSd(pairs.map((p) => p.diff - biasFor(fit, p)));
  return fit;
}

/* ---------------- validación hacia delante ---------------- */

export interface Backtest {
  /** Pares sobre los que se ha comprobado (cada uno con un modelo ajustado solo con los anteriores). */
  evaluated: number;
  maeRaw: number | null;
  maeCorrected: number | null;
  /** 0,15 = el error medio baja un 15 % con la corrección. */
  improvement: number | null;
}

export function backtest(pairs: Pair[]): Backtest {
  const out: Backtest = { evaluated: 0, maeRaw: null, maeCorrected: null, improvement: null };
  if (pairs.length <= MIN_PAIRS) return out;
  const raw: number[] = [];
  const cor: number[] = [];
  for (let i = MIN_PAIRS; i < pairs.length; i++) {
    const fit = fitBias(pairs.slice(0, i));
    const p = pairs[i];
    raw.push(Math.abs(p.diff));
    cor.push(Math.abs(p.diff - biasFor(fit, p)));
  }
  out.evaluated = raw.length;
  out.maeRaw = mean(raw);
  out.maeCorrected = mean(cor);
  out.improvement = out.maeRaw > 0 ? 1 - out.maeCorrected / out.maeRaw : 0;
  return out;
}

/* ---------------- resumen ---------------- */

export interface GroupRow {
  label: string;
  n: number;
  /** Mediana de (monitor − capilar). */
  bias: number | null;
  /** Mitad del intervalo de confianza del 95 % del sesgo. */
  ci: number | null;
  mae: number | null;
  enough: boolean;
}

function rowOf(label: string, ps: Pair[]): GroupRow {
  const n = ps.length;
  if (!n) return { label, n, bias: null, ci: null, mae: null, enough: false };
  const d = ps.map((p) => p.diff);
  return {
    label,
    n,
    bias: median(d),
    ci: n > 1 ? (1.96 * 1.2533 * robustSd(d)) / Math.sqrt(n) : null,
    mae: mean(d.map(Math.abs)),
    enough: n >= MIN_GROUP,
  };
}

export type Status = 'recopilando' | 'aprendiendo' | 'fiable' | 'sin-mejora';

export interface Calibration {
  pairs: Pair[];
  n: number;
  status: Status;
  fit: Fit;
  test: Backtest;
  overall: GroupRow;
  byZone: GroupRow[];
  byArrow: GroupRow[];
  byBand: GroupRow[];
  /** % de pares con diferencia dentro de ±15 mg/dL (<100) o ±15 % (≥100), criterio habitual de exactitud. */
  within15: number | null;
  /** Capilares < 70: cuántos detectó también el monitor (< 70). */
  hypo: { n: number; detected: number; falseAlarms: number };
  /** Contraste con el modelo predictivo (solo informativo). */
  model: { n: number; maeModelVsCap: number | null; maeMonVsCap: number | null };
}

export function buildCalibration(pairs: Pair[]): Calibration {
  const n = pairs.length;
  const fit = fitBias(pairs);
  const test = backtest(pairs);
  let status: Status;
  if (n < MIN_PAIRS) status = 'recopilando';
  else if (n < MIN_RELIABLE || test.evaluated < MIN_BACKTEST) status = 'aprendiendo';
  else status = (test.improvement ?? 0) >= MIN_IMPROVEMENT ? 'fiable' : 'sin-mejora';

  const within = pairs.filter((p) => Math.abs(p.diff) <= (p.cap < 100 ? 15 : 0.15 * p.cap)).length;
  const lowCap = pairs.filter((p) => p.cap < 70);
  const withPred = pairs.filter((p) => typeof p.pred === 'number');
  return {
    pairs,
    n,
    status,
    fit,
    test,
    overall: rowOf('Todos', pairs),
    byZone: ZONES.map((z) => rowOf(ZONE_LABEL[z], pairs.filter((p) => p.zone === z))),
    byArrow: ARROWS_G.map((a) => rowOf(ARROW_LABEL[a], pairs.filter((p) => p.arrow === a))),
    byBand: BANDS.map((b) => rowOf(BAND_LABEL[b], pairs.filter((p) => p.band === b))),
    within15: n ? (within / n) * 100 : null,
    hypo: {
      n: lowCap.length,
      detected: lowCap.filter((p) => p.mon < 70).length,
      falseAlarms: pairs.filter((p) => p.mon < 70 && p.cap >= 70).length,
    },
    model: {
      n: withPred.length,
      maeModelVsCap: withPred.length ? mean(withPred.map((p) => Math.abs((p.pred as number) - p.cap))) : null,
      maeMonVsCap: withPred.length ? mean(withPred.map((p) => Math.abs(p.diff))) : null,
    },
  };
}

/* ---------------- aviso para una lectura concreta ---------------- */

export type HintLevel = 'ok' | 'info' | 'cuidado';
export interface Hint {
  level: HintLevel;
  text: string;
}

/**
 * Aviso para una lectura del MONITOR. Solo existe cuando el aprendizaje está validado (estado «fiable»);
 * antes de eso devuelve null para no inducir a error.
 */
export function hintFor(cal: Calibration | null, value: number, arrow: Arrow | null | undefined, date: string, sensors: readonly string[] | undefined): Hint | null {
  if (!cal || cal.status !== 'fiable' || !Number.isFinite(value) || value <= 0) return null;
  const ctx = contextOf(value, arrow, date, sensors);
  const bias = biasFor(cal.fit, ctx);
  const spread = Math.max(8, 1.96 * cal.fit.sd);
  const est = Math.round(value - bias);
  const lo = Math.round(est - spread);
  const hi = Math.round(est + spread);
  const abs = Math.round(Math.abs(bias));
  if (Math.abs(bias) < MIN_RELEVANT_DIFF) {
    // sin sesgo apreciable: avisar solo si la dispersión habitual cruza el límite de hipoglucemia
    if (value >= 70 && value <= 110 && lo < 70) {
      return { level: 'cuidado', text: `En condiciones parecidas el capilar puede salir hasta ${lo} mg/dL. Confirma con capilar.` };
    }
    return { level: 'ok', text: 'En condiciones parecidas, el monitor suele coincidir con el capilar.' };
  }
  const dir = bias > 0 ? 'de más' : 'de menos';
  const base = `En condiciones parecidas el monitor suele marcar unos ${abs} mg/dL ${dir}. Estimación orientativa: ${est} mg/dL (habitual entre ${lo} y ${hi}).`;
  if (value >= 70 && est - spread < 70 && value <= 130) {
    return { level: 'cuidado', text: `${base} Podría estar más baja de lo que marca: confirma con capilar.` };
  }
  return { level: 'info', text: `${base} Confirma con capilar si vas a decidir una dosis.` };
}
