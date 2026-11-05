/**
 * Informe de glucosa para la consulta: tiempo en rango, media, GMI, variabilidad y perfil ambulatorio de glucosa (AGP).
 *
 * Cálculo puro (sin Angular). Solo usa la serie continua del sensor (`DayRecord.sensor`): las mediciones manuales no se mezclan
 * porque no están repartidas de forma uniforme y sesgarían la media y el tiempo en rango.
 * Los objetivos son los del consenso internacional sobre métricas de monitorización continua (Battelino et al., Diabetes Care 2019);
 * son orientativos, los objetivos de cada niño los fija su equipo médico.
 */
import { median } from './calibration';
import { HIGH, LOW } from './evolution';
import { DayRecord } from './models';
import { quantile } from './predictor-eval';
import { addDays, strToDate } from './util';

export const VLOW = 54;
export const VHIGH = 250;
/** Un episodio de hipoglucemia dura al menos esto (min). */
export const HYPO_MIN = 15;
/** Lecturas mínimas por tramo de 30 min para dibujar su percentil en el AGP. */
export const AGP_MIN_N = 6;
export const AGP_BIN = 30;
/** Cobertura mínima de datos del consenso (fracción del periodo) y días recomendados. */
export const MIN_COVERAGE = 0.7;
export const CONSENSUS_DAYS = 14;
/** Si entre dos lecturas pasa más de esto (min), no se consideran del mismo tramo continuo. */
const MAX_GAP = 20;

interface P {
  /** Minutos absolutos: nº de día × 1440 + minuto del día. */
  a: number;
  /** Minuto del día. */
  m: number;
  g: number;
  date: string;
}

function dayNum(date: string): number {
  const d = strToDate(date);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/** Lecturas del sensor de los días entre `from` y `to` (incluidos), ordenadas. */
export function sensorPoints(days: DayRecord[], from: string, to: string): P[] {
  const out: P[] = [];
  for (const d of days) {
    if (d.date < from || d.date > to || !Array.isArray(d.sensor)) continue;
    const n = dayNum(d.date);
    const s = d.sensor;
    for (let i = 0; i + 1 < s.length; i += 2) {
      const m = s[i];
      const g = s[i + 1];
      if (Number.isFinite(m) && Number.isFinite(g) && m >= 0 && m < 1440 && g > 0) out.push({ a: n * 1440 + m, m, g, date: d.date });
    }
  }
  return out.sort((x, y) => x.a - y.a);
}

/** Último día con lecturas del sensor (o null). */
export function lastSensorDate(days: DayRecord[]): string | null {
  let best: string | null = null;
  for (const d of days) if (Array.isArray(d.sensor) && d.sensor.length >= 2 && (!best || d.date > best)) best = d.date;
  return best;
}

/** Intervalo habitual entre lecturas (min): el del propio archivo, redondeado a 1, 5, 10 o 15. */
export function readingInterval(pts: P[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i].a - pts[i - 1].a;
    if (g > 0 && g <= 30) gaps.push(g);
  }
  if (!gaps.length) return 15;
  const m = median(gaps);
  return [1, 5, 10, 15].reduce((b, c) => (Math.abs(c - m) < Math.abs(b - m) ? c : b), 15);
}

const pct = (k: number, n: number): number => (n ? (100 * k) / n : 0);

export interface Tir {
  vlow: number; // < 54
  low: number; // 54–69
  range: number; // 70–180
  high: number; // 181–250
  vhigh: number; // > 250
  /** < 70 en total y > 180 en total. */
  below: number;
  above: number;
}

export interface Summary {
  from: string;
  to: string;
  /** Días del periodo y días con alguna lectura. */
  nDays: number;
  daysWithData: number;
  readings: number;
  interval: number;
  /** Fracción del periodo con datos (0–1). */
  coverage: number;
  mean: number;
  sd: number;
  cv: number;
  gmi: number;
  min: number;
  max: number;
  tir: Tir;
  /** Datos suficientes según el consenso: ≥ 70 % del periodo (y se avisa si son menos de 14 días). */
  enough: boolean;
}

/** GMI (indicador de gestión de glucosa, %) a partir de la media en mg/dL. */
export const gmiOf = (meanMgdl: number): number => 3.31 + 0.02392 * meanMgdl;

function tirOf(gs: number[]): Tir {
  const n = gs.length;
  const c = (f: (g: number) => boolean) => gs.filter(f).length;
  const vlow = pct(c((g) => g < VLOW), n);
  const low = pct(c((g) => g >= VLOW && g < LOW), n);
  const range = pct(c((g) => g >= LOW && g <= HIGH), n);
  const high = pct(c((g) => g > HIGH && g <= VHIGH), n);
  const vhigh = pct(c((g) => g > VHIGH), n);
  return { vlow, low, range, high, vhigh, below: vlow + low, above: high + vhigh };
}

/** Resumen de glucosa del periodo [from, to]; null si no hay lecturas. */
export function summarize(days: DayRecord[], from: string, to: string): Summary | null {
  const pts = sensorPoints(days, from, to);
  if (!pts.length) return null;
  const gs = pts.map((p) => p.g);
  const interval = readingInterval(pts);
  const nDays = dayNum(to) - dayNum(from) + 1;
  // el último día puede estar a medias (importado a media jornada): solo cuenta hasta su última lectura
  const lastPt = pts[pts.length - 1];
  const lastIsTo = lastPt.date === to;
  const expected = (nDays - 1) * 1440 + (lastIsTo ? Math.min(1440, lastPt.m + interval) : 1440);
  const coverage = Math.min(1, (pts.length * interval) / Math.max(interval, expected));
  const mean = gs.reduce((a, b) => a + b, 0) / gs.length;
  const sd = Math.sqrt(gs.reduce((a, b) => a + (b - mean) ** 2, 0) / gs.length);
  return {
    from,
    to,
    nDays,
    daysWithData: new Set(pts.map((p) => p.date)).size,
    readings: pts.length,
    interval,
    coverage,
    mean,
    sd,
    cv: mean > 0 ? (100 * sd) / mean : 0,
    gmi: gmiOf(mean),
    min: Math.min(...gs),
    max: Math.max(...gs),
    tir: tirOf(gs),
    enough: coverage >= MIN_COVERAGE,
  };
}

/* ---------------- objetivos del consenso ---------------- */

export interface Target {
  key: string;
  label: string;
  value: string;
  goal: string;
  /** true = dentro del objetivo; null = sin objetivo numérico. */
  ok: boolean | null;
}

const f0 = (x: number): string => Math.round(x).toLocaleString('es-ES');
const f1 = (x: number): string => x.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function targets(s: Summary): Target[] {
  return [
    { key: 'range', label: 'En rango (70–180)', value: `${f0(s.tir.range)} %`, goal: 'más del 70 %', ok: s.tir.range > 70 },
    { key: 'below', label: 'Por debajo de 70', value: `${f1(s.tir.below)} %`, goal: 'menos del 4 %', ok: s.tir.below < 4 },
    { key: 'vlow', label: 'Por debajo de 54', value: `${f1(s.tir.vlow)} %`, goal: 'menos del 1 %', ok: s.tir.vlow < 1 },
    { key: 'above', label: 'Por encima de 180', value: `${f0(s.tir.above)} %`, goal: 'menos del 25 %', ok: s.tir.above < 25 },
    { key: 'vhigh', label: 'Por encima de 250', value: `${f1(s.tir.vhigh)} %`, goal: 'menos del 5 %', ok: s.tir.vhigh < 5 },
    { key: 'cv', label: 'Variabilidad (CV)', value: `${f0(s.cv)} %`, goal: '36 % o menos', ok: s.cv <= 36 },
  ];
}

/* ---------------- hipoglucemias ---------------- */

export interface HypoSummary {
  /** Episodios de al menos HYPO_MIN minutos por debajo de 70 y los que bajaron de 54. */
  events: number;
  severe: number;
  /** Minutos totales por debajo de 70 (episodios) y duración media. */
  minutes: number;
  meanMin: number | null;
  longest: number;
  /** Por franja del comienzo: madrugada 0–6, mañana 6–12, tarde 12–18, noche 18–24. */
  byPart: number[];
}

export const HYPO_PARTS = ['Madrugada (0–6 h)', 'Mañana (6–12 h)', 'Tarde (12–18 h)', 'Noche (18–24 h)'];

export function hypoEvents(days: DayRecord[], from: string, to: string): HypoSummary {
  const pts = sensorPoints(days, from, to);
  const interval = readingInterval(pts);
  const out: HypoSummary = { events: 0, severe: 0, minutes: 0, meanMin: null, longest: 0, byPart: [0, 0, 0, 0] };
  let run: P[] = [];
  const close = () => {
    if (!run.length) return;
    const dur = run[run.length - 1].a - run[0].a + interval;
    if (dur >= HYPO_MIN) {
      out.events++;
      out.minutes += dur;
      out.longest = Math.max(out.longest, dur);
      if (run.some((p) => p.g < VLOW)) out.severe++;
      out.byPart[Math.min(3, Math.floor(run[0].m / 360))]++;
    }
    run = [];
  };
  let prev: P | null = null;
  for (const p of pts) {
    // un hueco largo cierra el episodio (no sabemos qué pasó en medio)
    if (prev && p.a - prev.a > MAX_GAP) close();
    if (p.g < LOW) run.push(p);
    else close();
    prev = p;
  }
  close();
  out.meanMin = out.events ? out.minutes / out.events : null;
  return out;
}

/* ---------------- perfil ambulatorio (AGP) ---------------- */

export interface AgpBin {
  /** Minuto del día en que empieza el tramo. */
  t: number;
  n: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
}

/** Perfil de glucosa por hora del día: mediana y rangos habituales (25–75 y 5–95) de todos los días a la vez. */
export function agpProfile(days: DayRecord[], from: string, to: string, bin = AGP_BIN, minN = AGP_MIN_N): AgpBin[] {
  const pts = sensorPoints(days, from, to);
  const nb = Math.floor(1440 / bin);
  const buckets: number[][] = Array.from({ length: nb }, () => []);
  for (const p of pts) buckets[Math.min(nb - 1, Math.floor(p.m / bin))].push(p.g);
  return buckets.map((b, i) => {
    const s = [...b].sort((x, y) => x - y);
    const ok = s.length >= minN;
    return {
      t: i * bin,
      n: s.length,
      p5: ok ? quantile(s, 0.05) : NaN,
      p25: ok ? quantile(s, 0.25) : NaN,
      p50: ok ? quantile(s, 0.5) : NaN,
      p75: ok ? quantile(s, 0.75) : NaN,
      p95: ok ? quantile(s, 0.95) : NaN,
    };
  });
}

/* ---------------- por semanas ---------------- */

export interface Block {
  from: string;
  to: string;
  summary: Summary | null;
}

/** Trozos de `size` días hacia atrás desde `to` (el más reciente primero). */
export function blocks(days: DayRecord[], to: string, nDays: number, size = 7): Block[] {
  const out: Block[] = [];
  const first = addDays(to, -(nDays - 1));
  let end = to;
  while (end >= first) {
    const start = addDays(end, -(size - 1)) < first ? first : addDays(end, -(size - 1));
    out.push({ from: start, to: end, summary: summarize(days, start, end) });
    end = addDays(start, -1);
  }
  return out;
}

/* ---------------- informe completo ---------------- */

export interface Report {
  summary: Summary | null;
  targets: Target[];
  hypos: HypoSummary | null;
  agp: AgpBin[];
  /** Comparación por semanas (solo con periodos de más de 7 días). */
  weeks: Block[];
  notes: string[];
}

/** Informe de los `nDays` días que terminan en `to` (normalmente el último día con datos del sensor). */
export function buildReport(days: DayRecord[], to: string, nDays: number): Report {
  const from = addDays(to, -(nDays - 1));
  const summary = summarize(days, from, to);
  const notes: string[] = [];
  if (!summary) {
    return { summary, targets: [], hypos: null, agp: [], weeks: [], notes: ['No hay lecturas del sensor en este periodo. Importa el CSV del monitor en la pestaña Monitor.'] };
  }
  if (!summary.enough) {
    notes.push(`Solo hay datos del ${f0(summary.coverage * 100)} % del periodo (el consenso pide al menos el 70 %): las cifras pueden no representar bien lo que pasa de verdad.`);
  }
  if (summary.nDays < CONSENSUS_DAYS) {
    notes.push(`El periodo es de ${summary.nDays} días; el consenso recomienda ${CONSENSUS_DAYS} para valorar la glucosa.`);
  }
  return {
    summary,
    targets: targets(summary),
    hypos: hypoEvents(days, from, to),
    agp: agpProfile(days, from, to),
    weeks: nDays > 7 ? blocks(days, to, nDays) : [],
    notes,
  };
}
