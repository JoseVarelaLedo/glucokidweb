/**
 * Medir la previsión y dibujar su incertidumbre.
 *
 * Cálculo puro (sin Angular). Para cada comida con curva prevista se compara lo previsto con lo que de verdad midió el sensor
 * (o, si ese día no hay serie, las mediciones manuales) a los 30, 60… 300 minutos. Es solo OBSERVACIÓN: no cambia ningún cálculo
 * del modelo ni de la calculadora de dosis.
 *
 * Importante: la previsión de cada día se recalcula con los ajustes de ahora y con lo que de verdad se anotó (hidratos y dosis,
 * incluidas las correcciones posteriores). Mide, por tanto, cuánto se parece el modelo a la realidad cuando los datos están bien
 * anotados, no lo que aún no se sabía al empezar la comida.
 */
import { median, sensorAt } from './calibration';
import { DayRecord, Food, Settings } from './models';
import { Episode, analyzeDay, predictedAt } from './predict';
import { addDays } from './util';

/** Instantes (min desde la comida) en los que se compara. */
export const GRID = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300];
/** Horizontes que se muestran en las tablas. */
export const HORIZONS = [60, 120, 180];
/** Mínimo de comidas para fiarse de una celda de la tabla. */
export const MIN_CELL = 6;
/** Margen (mg/dL) para contar un acierto «cercano». */
export const NEAR = 30;
/** Residuos mínimos por instante para dibujar la banda. */
export const MIN_BAND_N = 20;
/** Cuantiles de la banda: el 80 % central de los casos. */
export const BAND_LO = 0.1;
export const BAND_HI = 0.9;
/** Anchura (mg/dL) de la banda a las 2 h a partir de la cual la previsión se considera poco informativa. */
export const BAND_WIDE = 120;
/** Como mucho, los residuos más recientes que se usan para la banda de cada instante. */
const BAND_KEEP = 400;
const PLAUS_MIN = 20;
const PLAUS_MAX = 400;
const MAX_GAP = 10;

export type TruthSrc = 'sensor' | 'manual';

export interface EvalRecord {
  date: string;
  mealId: string;
  meal: string;
  /** Minuto del día en que empieza la comida. */
  t0: number;
  minutes: number;
  pred: number;
  truth: number;
  /** Lo que daría «la glucemia no cambia» (valor al empezar). */
  naive: number;
  src: TruthSrc;
  confidence: Episode['confidence'];
}

interface Pt {
  t: number;
  g: number;
}

function seriesOf(day: DayRecord | undefined, offset: number): Pt[] {
  const s = day?.sensor;
  const out: Pt[] = [];
  if (!Array.isArray(s)) return out;
  for (let i = 0; i + 1 < s.length; i += 2) {
    if (Number.isFinite(s[i]) && Number.isFinite(s[i + 1]) && s[i + 1] > 0) out.push({ t: s[i] + offset, g: s[i + 1] });
  }
  return out;
}

/** Una fila por comida con curva y por instante comparable. */
export function collectRecords(days: DayRecord[], s: Settings, foods: Food[]): EvalRecord[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: EvalRecord[] = [];
  for (const day of days) {
    const a = analyzeDay(day, s, foods);
    if (!a.ready) continue;
    // la serie de la noche siguiente permite valorar la cena
    const series = [...seriesOf(day, 0), ...seriesOf(byDate.get(addDays(day.date, 1)), 1440)].sort((x, y) => x.t - y.t);
    for (const ep of a.episodes) {
      if (ep.points.length < 2 || ep.confidence === 'baja') continue;
      const last = ep.points[ep.points.length - 1].t;
      for (const dt of GRID) {
        const t = ep.t0 + dt;
        if (t > last) break;
        const pred = predictedAt(ep, t);
        if (pred === null) continue;
        let truth: number | null = null;
        let src: TruthSrc = 'sensor';
        const sv = sensorAt(series, t);
        if (sv) truth = sv.v;
        else {
          let best: { d: number; g: number } | null = null;
          for (const m of a.measured) {
            const d = Math.abs(m.t - t);
            // el propio valor de partida no cuenta como «verdad» posterior
            if (d <= MAX_GAP && m.t > ep.t0 + 5 && (!best || d < best.d)) best = { d, g: m.g };
          }
          if (best) {
            truth = best.g;
            src = 'manual';
          }
        }
        if (truth === null) continue;
        out.push({ date: day.date, mealId: ep.mealId, meal: ep.name, t0: ep.t0, minutes: dt, pred, truth, naive: ep.g0, src, confidence: ep.confidence });
      }
    }
  }
  return out;
}

/* ---------------- métricas ---------------- */

export interface Metric {
  n: number;
  /** Error absoluto medio de la previsión (mg/dL). */
  mae: number;
  /** Media de (real − previsto): positivo = la glucemia real queda por encima de lo previsto. */
  bias: number;
  /** Fracción de casos a menos de NEAR mg/dL de lo real. */
  near: number;
  /** Error absoluto medio de «la glucemia no cambia». */
  naiveMae: number;
  /** 1 − mae/naiveMae: >0 mejora a «no cambia»; null si no se puede calcular. */
  skill: number | null;
  /** n suficiente para fiarse. */
  enough: boolean;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function metric(rs: EvalRecord[]): Metric | null {
  if (!rs.length) return null;
  const err = rs.map((r) => r.truth - r.pred);
  const mae = mean(err.map(Math.abs));
  const naiveMae = mean(rs.map((r) => Math.abs(r.truth - r.naive)));
  return {
    n: rs.length,
    mae,
    bias: mean(err),
    near: err.filter((e) => Math.abs(e) <= NEAR).length / rs.length,
    naiveMae,
    skill: naiveMae > 0 ? 1 - mae / naiveMae : null,
    enough: rs.length >= MIN_CELL,
  };
}

export interface Group {
  label: string;
  /** Comidas distintas en el grupo. */
  meals: number;
  cells: Array<Metric | null>;
}

export const PARTS: Array<{ label: string; from: number; to: number }> = [
  { label: 'Mañana (hasta las 11:00)', from: 0, to: 660 },
  { label: 'Mediodía (11:00–16:00)', from: 660, to: 960 },
  { label: 'Tarde (16:00–20:00)', from: 960, to: 1200 },
  { label: 'Noche (desde las 20:00)', from: 1200, to: 1e9 },
];

export interface Evaluation {
  /** Comidas distintas valoradas, días y comparaciones. */
  meals: number;
  days: number;
  records: number;
  /** Fracción de comparaciones hechas con la serie del sensor. */
  sensorShare: number;
  horizons: Array<{ minutes: number; m: Metric | null }>;
  byMeal: Group[];
  byPart: Group[];
  notes: string[];
}

const mealsOf = (rs: EvalRecord[]): number => new Set(rs.map((r) => r.date + '|' + r.mealId)).size;

function group(label: string, rs: EvalRecord[]): Group {
  return { label, meals: mealsOf(rs), cells: HORIZONS.map((h) => metric(rs.filter((r) => r.minutes === h))) };
}

export function evaluate(records: EvalRecord[]): Evaluation {
  const rs = records.filter((r) => r.confidence !== 'baja');
  const horizons = HORIZONS.map((h) => ({ minutes: h, m: metric(rs.filter((r) => r.minutes === h)) }));
  const names = [...new Set(rs.map((r) => r.meal))].sort((a, b) => {
    const ta = median(rs.filter((r) => r.meal === a).map((r) => r.t0));
    const tb = median(rs.filter((r) => r.meal === b).map((r) => r.t0));
    return ta - tb;
  });
  const byMeal = names.map((n) => group(n, rs.filter((r) => r.meal === n)));
  const byPart = PARTS.map((p) => group(p.label, rs.filter((r) => r.t0 >= p.from && r.t0 < p.to))).filter((g) => g.meals > 0);

  const notes: string[] = [];
  const h2 = horizons.find((h) => h.minutes === 120)?.m ?? null;
  if (!h2 || !h2.enough) {
    notes.push(`Todavía hay pocos datos para valorar la previsión a las 2 h (${h2 ? h2.n : 0} comparaciones; hacen falta al menos ${MIN_CELL}). Importa el CSV del sensor y sigue anotando comidas con dosis.`);
  } else {
    const dir = Math.abs(h2.bias) < 10 ? null : h2.bias > 0 ? 'por encima' : 'por debajo';
    notes.push(
      `A las 2 h de la comida la previsión se desvía de media ${Math.round(h2.mae)} mg/dL (${Math.round(h2.near * 100)} % de los casos a menos de ${NEAR} mg/dL).` +
        (dir ? ` De media, lo real queda ${Math.round(Math.abs(h2.bias))} mg/dL ${dir} de lo previsto.` : ''),
    );
    if (h2.skill !== null) {
      notes.push(
        h2.skill > 0.1
          ? `Mejora a «la glucemia sigue igual» en un ${Math.round(h2.skill * 100)} %.`
          : 'A las 2 h no mejora de forma clara a suponer que la glucemia sigue igual: tómala solo como orientación.',
      );
    }
  }
  const worst = [...byMeal].filter((g) => g.cells[1]?.enough).sort((a, b) => (b.cells[1]?.mae ?? 0) - (a.cells[1]?.mae ?? 0))[0];
  if (worst && byMeal.filter((g) => g.cells[1]?.enough).length > 1) {
    notes.push(`La comida con más desviación a las 2 h es «${worst.label}» (${Math.round(worst.cells[1]?.mae ?? 0)} mg/dL de media).`);
  }
  return {
    meals: mealsOf(rs),
    days: new Set(rs.map((r) => r.date)).size,
    records: rs.length,
    sensorShare: rs.length ? rs.filter((r) => r.src === 'sensor').length / rs.length : 0,
    horizons,
    byMeal,
    byPart,
    notes,
  };
}

/* ---------------- bandas de incertidumbre ---------------- */

/** Cuantil con interpolación lineal de una lista ordenada. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  const hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
}

export interface BandModel {
  minutes: number[];
  /** Cuantiles de (real − previsto) por instante; NaN si no hay datos suficientes. */
  lo: number[];
  mid: number[];
  hi: number[];
  n: number[];
  /** Hay datos suficientes a las 2 h para dibujar bandas. */
  ready: boolean;
  /** Comparaciones que hay a las 2 h y las que hacen falta. */
  have: number;
  needed: number;
  /** Anchura de la banda a las 2 h (mg/dL). */
  width120: number | null;
  /** La banda es tan ancha que la previsión informa poco. */
  wide: boolean;
  /** Cuántas veces cayó lo real dentro de la banda calculada solo con días anteriores (objetivo ≈ 80 %). */
  coverage: { n: number; rate: number } | null;
}

export function buildBands(records: EvalRecord[]): BandModel {
  const rs = records.filter((r) => r.confidence !== 'baja');
  const lo: number[] = [];
  const mid: number[] = [];
  const hi: number[] = [];
  const nn: number[] = [];
  let hits = 0;
  let tested = 0;
  for (const dt of GRID) {
    const at = rs.filter((r) => r.minutes === dt).sort((a, b) => a.date.localeCompare(b.date));
    const res = at.map((r) => r.truth - r.pred).sort((a, b) => a - b);
    nn.push(at.length);
    if (at.length >= MIN_BAND_N) {
      lo.push(quantile(res, BAND_LO));
      mid.push(quantile(res, 0.5));
      hi.push(quantile(res, BAND_HI));
    } else {
      lo.push(NaN);
      mid.push(NaN);
      hi.push(NaN);
    }
    // validación hacia delante: la banda de cada día se calcula solo con días anteriores
    const prior: number[] = []; // ordenado
    const priorOrder: number[] = []; // en orden de llegada, para olvidar lo más antiguo
    let i = 0;
    while (i < at.length) {
      let j = i;
      while (j < at.length && at[j].date === at[i].date) j++;
      if (prior.length >= MIN_BAND_N) {
        const a = quantile(prior, BAND_LO);
        const b = quantile(prior, BAND_HI);
        for (let k = i; k < j; k++) {
          const e = at[k].truth - at[k].pred;
          tested++;
          if (e >= a && e <= b) hits++;
        }
      }
      for (let k = i; k < j; k++) {
        const e = at[k].truth - at[k].pred;
        priorOrder.push(e);
        let p = 0;
        let q = prior.length;
        while (p < q) {
          const m = (p + q) >> 1;
          if (prior[m] < e) p = m + 1;
          else q = m;
        }
        prior.splice(p, 0, e);
        if (priorOrder.length > BAND_KEEP) {
          const old = priorOrder.shift() as number;
          let a = 0;
          let b = prior.length;
          while (a < b) {
            const m = (a + b) >> 1;
            if (prior[m] < old) a = m + 1;
            else b = m;
          }
          prior.splice(a, 1);
        }
      }
      i = j;
    }
  }
  const i120 = GRID.indexOf(120);
  const ready = Number.isFinite(lo[i120]);
  const width120 = ready ? hi[i120] - lo[i120] : null;
  return {
    minutes: [...GRID],
    lo,
    mid,
    hi,
    n: nn,
    ready,
    have: nn[i120],
    needed: MIN_BAND_N,
    width120,
    wide: width120 !== null && width120 > BAND_WIDE,
    coverage: tested >= 30 ? { n: tested, rate: hits / tested } : null,
  };
}

export interface BandPoint {
  t: number;
  lo: number;
  hi: number;
}

const clamp = (x: number): number => Math.max(PLAUS_MIN, Math.min(PLAUS_MAX, x));

/** Banda de un episodio: la curva prevista desplazada por los cuantiles de error de cada instante. null si no hay banda fiable. */
export function bandFor(model: BandModel | null, ep: Episode): BandPoint[] | null {
  if (!model || !model.ready || ep.points.length < 2 || ep.confidence === 'baja') return null;
  const last = ep.points[ep.points.length - 1].t;
  const out: BandPoint[] = [{ t: ep.t0, lo: ep.g0, hi: ep.g0 }];
  for (let i = 0; i < GRID.length; i++) {
    if (!Number.isFinite(model.lo[i])) break; // solo tramos contiguos con datos suficientes
    const t = ep.t0 + GRID[i];
    if (t > last) break;
    const p = predictedAt(ep, t);
    if (p === null) break;
    out.push({ t, lo: clamp(p + model.lo[i]), hi: clamp(p + model.hi[i]) });
  }
  return out.length >= 3 ? out : null;
}
