/**
 * Noches y ayunas: cómo se comporta la glucosa cuando no hay comida ni insulina rápida «activa».
 *
 * Cálculo puro (sin Angular). Para cada noche se toma la ventana de 00:00 a 06:00 (o hasta la primera comida, dosis rápida o ración
 * extra del día, si es antes) y se descarta el comienzo mientras aún puede quedar efecto de la cena o de la última rápida de la
 * tarde anterior. Solo se valoran noches «limpias» con datos suficientes. Todo son OBSERVACIONES para comentar con el equipo médico:
 * nunca se sugiere cambiar una dosis.
 */
import { median } from './calibration';
import { HIGH, LOW } from './evolution';
import { VLOW, HYPO_MIN, AgpBin } from './agp';
import { DayRecord, Food, Settings } from './models';
import { dayEvents, sanitizeModel, toMin } from './predict';
import { quantile } from './predictor-eval';
import { addDays } from './util';

/** Fin de la noche si no hay antes ninguna comida o dosis (min). */
export const NIGHT_END = 360;
/** Minutos limpios mínimos para valorar una noche. */
export const MIN_CLEAN = 180;
/** Fracción mínima de la ventana con lecturas. */
export const MIN_NIGHT_COVERAGE = 0.7;
/** Noches limpias mínimas para sacar conclusiones. */
export const MIN_NIGHTS = 5;
/** Cambio durante la noche (mg/dL) a partir del cual se habla de subida o bajada, y fracción de noches que debe repetirse. */
export const DRIFT = 30;
export const SHARE = 0.6;
/** Noches con hipoglucemia a partir de las cuales se avisa. */
export const HYPO_NIGHTS_ALERT = 2;
const MAX_GAP = 20;

export interface Night {
  date: string;
  /** Ventana valorada (minutos del día). */
  start: number;
  end: number;
  readings: number;
  startG: number;
  endG: number;
  /** endG − startG (mg/dL), con medianas de 3 lecturas para no depender de un valor suelto. */
  change: number;
  min: number;
  max: number;
  /** % de lecturas por debajo de 70. */
  tbr: number;
  /** Hubo un episodio de al menos 15 min por debajo de 70 / por debajo de 54. */
  hypo: boolean;
  vlow: boolean;
  /** Glucosa justo antes de la primera comida o dosis de la mañana, si llevaba ≥ 3 h sin comer ni dosis. */
  fasting: number | null;
  /** Hora de la primera comida/dosis del día (min), o null. */
  firstEvent: number | null;
}

export interface NightSkip {
  date: string;
  reason: string;
}

export interface Finding {
  level: 'info' | 'atencion' | 'alerta';
  text: string;
}

export interface FastingSummary {
  n: number;
  median: number;
  p25: number;
  p75: number;
  high: number; // noches/ayunas > 180
  low: number; // < 70
}

export interface Overnight {
  nights: Night[];
  skipped: NightSkip[];
  /** Noches de la lista con subida (≥ DRIFT), bajada (≤ −DRIFT) o estables. */
  rising: number;
  falling: number;
  stable: number;
  hypoNights: number;
  vlowNights: number;
  medianChange: number | null;
  medianStart: number | null;
  medianEnd: number | null;
  fasting: FastingSummary | null;
  /** Perfil de las ventanas limpias, tramos de 30 min entre 00:00 y 06:00 (para dibujarlo). */
  profile: AgpBin[];
  findings: Finding[];
}

interface P {
  a: number;
  m: number;
  g: number;
}

function pointsOf(d: DayRecord | undefined): P[] {
  const s = d?.sensor;
  const out: P[] = [];
  if (!Array.isArray(s)) return out;
  for (let i = 0; i + 1 < s.length; i += 2) if (Number.isFinite(s[i]) && Number.isFinite(s[i + 1]) && s[i + 1] > 0) out.push({ a: s[i], m: s[i], g: s[i + 1] });
  return out.sort((x, y) => x.m - y.m);
}

const medianOf = (xs: number[]): number => median(xs);

/** Hay algo anotado ese día (si no, no podemos fiarnos de que «no hubo comida»). */
const hasLog = (d: DayRecord): boolean => (d.meals ?? []).some((m) => (m.before?.units ?? 0) > 0 || (m.items ?? []).length > 0 || m.before?.value != null) || (d.extras ?? []).length > 0;

export function analyzeNights(days: DayRecord[], from: string, to: string, s: Settings, foods: Food[]): Overnight {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const model = sanitizeModel(s.model);
  const nights: Night[] = [];
  const skipped: NightSkip[] = [];
  const winReadings: P[][] = [];

  for (const day of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    if (day.date < from || day.date > to) continue;
    const pts = pointsOf(day);
    if (!pts.length) continue;
    const prev = byDate.get(addDays(day.date, -1));
    if (!hasLog(day)) {
      skipped.push({ date: day.date, reason: 'sin comidas ni dosis anotadas ese día' });
      continue;
    }
    if (!prev || !hasLog(prev)) {
      skipped.push({ date: day.date, reason: 'sin registro de la tarde anterior' });
      continue;
    }

    // Efecto que aún puede quedar de la tarde anterior (en minutos de la madrugada de este día)
    const pe = dayEvents(prev, s, foods);
    let start = 0;
    for (const i of pe.insulin) start = Math.max(start, i.t + model.diaMin - 1440);
    for (const c of pe.carbs) start = Math.max(start, c.t + Math.max(c.durationMin, model.carbMinFat) - 1440);
    // lo de este día: la ventana acaba en el primer evento
    const ev = dayEvents(day, s, foods);
    const times = [...ev.insulin.map((i) => i.t), ...ev.carbs.map((c) => c.t)];
    // las dosis o comidas con hora ilegible impiden saber cuándo empezó el día
    if (ev.issues.some((i) => /falta la hora/.test(i.text))) {
      skipped.push({ date: day.date, reason: 'comidas o dosis sin hora' });
      continue;
    }
    const firstEvent = times.length ? Math.min(...times) : null;
    // un evento antes de las 06:00 de la propia noche: ventana hasta ahí
    const end = Math.min(NIGHT_END, firstEvent ?? NIGHT_END);
    start = Math.max(0, Math.ceil(start));
    if (end - start < MIN_CLEAN) {
      skipped.push({ date: day.date, reason: start > 0 ? 'quedaba efecto de la cena o de la insulina de la tarde' : 'comida o dosis demasiado temprana' });
      continue;
    }
    const w = pts.filter((p) => p.m >= start && p.m < end);
    const gaps: number[] = [];
    for (let k = 1; k < pts.length; k++) if (pts[k].m - pts[k - 1].m <= 30) gaps.push(pts[k].m - pts[k - 1].m);
    const interval = gaps.length ? Math.max(1, medianOf(gaps)) : 15;
    if (w.length < 6 || (w.length * interval) / (end - start) < MIN_NIGHT_COVERAGE) {
      skipped.push({ date: day.date, reason: 'faltan lecturas del sensor durante la noche' });
      continue;
    }

    const first3 = medianOf(w.slice(0, 3).map((p) => p.g));
    const last3 = medianOf(w.slice(-3).map((p) => p.g));
    const gs = w.map((p) => p.g);

    // episodios de hipoglucemia dentro de la ventana
    let hypo = false;
    let vlow = false;
    let run: P[] = [];
    const close = () => {
      if (run.length && run[run.length - 1].m - run[0].m + interval >= HYPO_MIN) {
        hypo = true;
        if (run.some((p) => p.g < VLOW)) vlow = true;
      }
      run = [];
    };
    for (let k = 0; k < w.length; k++) {
      if (k && w[k].m - w[k - 1].m > MAX_GAP) close();
      if (w[k].g < LOW) run.push(w[k]);
      else close();
    }
    close();

    // ayunas: valor justo antes de la primera comida/dosis de la mañana
    let fasting: number | null = null;
    if (firstEvent !== null && firstEvent <= 720 && firstEvent - start >= MIN_CLEAN) {
      const f = pts.filter((p) => p.m >= firstEvent - 30 && p.m < firstEvent).map((p) => p.g);
      if (f.length) fasting = medianOf(f);
    }

    nights.push({
      date: day.date,
      start,
      end,
      readings: w.length,
      startG: first3,
      endG: last3,
      change: last3 - first3,
      min: Math.min(...gs),
      max: Math.max(...gs),
      tbr: (100 * gs.filter((g) => g < LOW).length) / gs.length,
      hypo,
      vlow,
      fasting,
      firstEvent,
    });
    winReadings.push(w);
  }

  const n = nights.length;
  const rising = nights.filter((x) => x.change >= DRIFT).length;
  const falling = nights.filter((x) => x.change <= -DRIFT).length;
  const hypoNights = nights.filter((x) => x.hypo).length;
  const vlowNights = nights.filter((x) => x.vlow).length;
  const medianChange = n ? medianOf(nights.map((x) => x.change)) : null;
  const fs = nights.map((x) => x.fasting).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const fasting: FastingSummary | null = fs.length
    ? { n: fs.length, median: quantile(fs, 0.5), p25: quantile(fs, 0.25), p75: quantile(fs, 0.75), high: fs.filter((g) => g > HIGH).length, low: fs.filter((g) => g < LOW).length }
    : null;

  // perfil de las ventanas limpias, tramos de 30 min
  const buckets: number[][] = Array.from({ length: 12 }, () => []);
  for (const w of winReadings) for (const p of w) buckets[Math.min(11, Math.floor(p.m / 30))].push(p.g);
  const profile: AgpBin[] = buckets.map((b, i) => {
    const sorted = [...b].sort((x, y) => x - y);
    const ok = sorted.length >= 4;
    const q = (p: number) => (ok ? quantile(sorted, p) : NaN);
    return { t: i * 30, n: sorted.length, p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
  });

  const out: Overnight = {
    nights,
    skipped,
    rising,
    falling,
    stable: n - rising - falling,
    hypoNights,
    vlowNights,
    medianChange,
    medianStart: n ? medianOf(nights.map((x) => x.startG)) : null,
    medianEnd: n ? medianOf(nights.map((x) => x.endG)) : null,
    fasting,
    profile,
    findings: [],
  };
  out.findings = findingsOf(out);
  return out;
}

const r0 = (x: number): string => Math.round(x).toLocaleString('es-ES');
const sign = (x: number): string => (x > 0 ? '+' : x < 0 ? '−' : '') + r0(Math.abs(x));
const TEAM = 'Es una observación para comentar con el equipo médico; no cambies ninguna dosis por tu cuenta.';

/** Frases prudentes a partir de las cifras. Solo se afirma algo si se repite en varias noches. */
export function findingsOf(o: Overnight): Finding[] {
  const n = o.nights.length;
  const f: Finding[] = [];
  if (n < MIN_NIGHTS) {
    f.push({
      level: 'info',
      text: `Solo hay ${n} ${n === 1 ? 'noche limpia' : 'noches limpias'}; hacen falta al menos ${MIN_NIGHTS} para ver si hay un patrón. Una noche es limpia si hay lecturas del sensor y no hay comida ni insulina rápida activa (también cuenta lo anotado la tarde anterior).`,
    });
  }
  // las bajadas se avisan siempre, aunque haya pocas noches
  if (o.vlowNights > 0) {
    f.push({ level: 'alerta', text: `En ${o.vlowNights} ${o.vlowNights === 1 ? 'noche' : 'noches'} la glucosa bajó de 54 mg/dL durante al menos 15 minutos. ${TEAM}` });
  }
  if (o.hypoNights >= HYPO_NIGHTS_ALERT || (n >= MIN_NIGHTS && o.hypoNights / n >= 0.15 && o.hypoNights > 0)) {
    f.push({
      level: 'alerta',
      text: `Hay hipoglucemias nocturnas (menos de 70 mg/dL) en ${o.hypoNights} de ${n} noches. Si se repiten, la insulina lenta y la cena son de las cosas que el equipo suele revisar. ${TEAM}`,
    });
  } else if (o.hypoNights === 1 && !o.vlowNights) {
    f.push({ level: 'atencion', text: `En una noche hubo una bajada por debajo de 70 mg/dL. Con una sola no se puede hablar de patrón; conviene tenerlo presente si se repite.` });
  }
  if (n >= MIN_NIGHTS && o.medianChange !== null) {
    if (o.rising / n >= SHARE && o.medianChange >= DRIFT) {
      f.push({
        level: 'atencion',
        text: `En ${o.rising} de ${n} noches la glucosa sube durante la noche (mediana ${sign(o.medianChange)} mg/dL entre el inicio y el final). Puede deberse a la cena, a la insulina lenta o a otros factores. ${TEAM}`,
      });
    } else if (o.falling / n >= SHARE && o.medianChange <= -DRIFT) {
      f.push({
        level: 'atencion',
        text: `En ${o.falling} de ${n} noches la glucosa baja durante la noche (mediana ${sign(o.medianChange)} mg/dL entre el inicio y el final). Puede deberse a la cena, a la insulina lenta o a otros factores. ${TEAM}`,
      });
    } else if (!o.hypoNights) {
      f.push({ level: 'info', text: `No se aprecia una subida o bajada repetida durante la noche (mediana ${sign(o.medianChange)} mg/dL).` });
    }
  }
  if (o.fasting && o.fasting.n >= MIN_NIGHTS) {
    const x = o.fasting;
    f.push({
      level: x.high / x.n >= SHARE ? 'atencion' : 'info',
      text:
        `En ayunas (antes de la primera comida o dosis, con al menos 3 h sin comer) la mediana es ${r0(x.median)} mg/dL (la mitad de los días, entre ${r0(x.p25)} y ${r0(x.p75)}), con ${x.n} ${x.n === 1 ? 'día' : 'días'} valorados.` +
        (x.high / x.n >= SHARE ? ` En ${x.high} de ellos superó 180 mg/dL. ${TEAM}` : ''),
    });
  }
  return f;
}
