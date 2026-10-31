import { DayRecord } from './models';
import { addDays, dateToStr, pad, strToDate } from './util';

/** Cálculo de la evolución por semanas, meses y año a partir de los registros de los días. Solo informativo. */

export type Period = 'semana' | 'mes' | 'anio';

export const LOW = 70;
export const HIGH = 180;
/** Mínimo de mediciones para comparar dos periodos con sentido. */
export const MIN_READINGS = 8;

export interface DateRange {
  from: string;
  to: string;
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];

/** Semana de lunes a domingo, mes o año natural que contiene la fecha. */
export function rangeOf(period: Period, anchor: string): DateRange {
  const d = strToDate(anchor);
  if (period === 'semana') {
    const offset = (d.getDay() + 6) % 7; // lunes = 0
    const from = addDays(anchor, -offset);
    return { from, to: addDays(from, 6) };
  }
  if (period === 'mes') {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    return { from: `${ym}-01`, to: `${ym}-${pad(last)}` };
  }
  return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` };
}

/** Desplaza la fecha de referencia n periodos (negativo = hacia atrás). */
export function shiftAnchor(period: Period, anchor: string, n: number): string {
  if (period === 'semana') return addDays(anchor, 7 * n);
  const d = strToDate(anchor);
  if (period === 'mes') return dateToStr(new Date(d.getFullYear(), d.getMonth() + n, 1));
  return dateToStr(new Date(d.getFullYear() + n, 0, 1));
}

export function periodLabel(period: Period, anchor: string): string {
  const r = rangeOf(period, anchor);
  const a = strToDate(r.from);
  const b = strToDate(r.to);
  if (period === 'anio') return String(a.getFullYear());
  if (period === 'mes') return `${MONTHS[a.getMonth()].replace(/^./, (c) => c.toUpperCase())} de ${a.getFullYear()}`;
  const sameMonth = a.getMonth() === b.getMonth();
  return sameMonth
    ? `${a.getDate()}–${b.getDate()} de ${MONTHS[b.getMonth()]} de ${b.getFullYear()}`
    : `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]} – ${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`;
}

/* ------------------------------------------------------------------ */

/** Todas las glucemias con valor de un día (comidas, mediciones extra y actividad). */
export function dayReadings(d: DayRecord): number[] {
  const out: number[] = [];
  const push = (v: number | null | undefined) => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.push(v);
  };
  for (const m of d.meals ?? []) {
    push(m.before?.value);
    push(m.after?.value);
  }
  for (const x of d.extras ?? []) push(x.value);
  for (const a of d.activities ?? []) {
    push(a.before?.value);
    push(a.after?.value);
  }
  return out;
}

function dayUnits(d: DayRecord, kind: 'rapida' | 'lenta'): number | null {
  let total = 0;
  let any = false;
  for (const m of d.meals ?? []) {
    if (m.kind === kind && typeof m.before?.units === 'number') {
      total += m.before.units;
      any = true;
    }
  }
  return any ? total : null;
}

function dayRations(d: DayRecord): number | null {
  let total = 0;
  let any = false;
  for (const m of d.meals ?? []) {
    for (const it of m.items ?? []) {
      if (typeof it.rations === 'number') {
        total += it.rations;
        any = true;
      }
    }
  }
  for (const x of d.extras ?? []) {
    if (typeof x.extraRations === 'number' && x.extraRations > 0) {
      total += x.extraRations;
      any = true;
    }
  }
  return any ? total : null;
}

export interface Stats {
  n: number; // mediciones
  days: number; // días con alguna medición
  mean: number | null;
  sd: number | null;
  cv: number | null; // coeficiente de variación, %
  min: number | null;
  max: number | null;
  low: number; // nº de mediciones < 70
  high: number; // nº de mediciones > 180
  pctLow: number;
  pctIn: number;
  pctHigh: number;
  rapidPerDay: number | null;
  lentaPerDay: number | null;
  rationsPerDay: number | null;
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function computeStats(days: DayRecord[]): Stats {
  const all: number[] = [];
  let withData = 0;
  const rapid: number[] = [];
  const lenta: number[] = [];
  const rations: number[] = [];
  for (const d of days) {
    const r = dayReadings(d);
    if (r.length) {
      withData++;
      all.push(...r);
    }
    const u = dayUnits(d, 'rapida');
    if (u !== null) rapid.push(u);
    const l = dayUnits(d, 'lenta');
    if (l !== null) lenta.push(l);
    const ra = dayRations(d);
    if (ra !== null) rations.push(ra);
  }
  const n = all.length;
  const mean = avg(all);
  let sd: number | null = null;
  if (mean !== null && n > 1) sd = Math.sqrt(all.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1));
  const low = all.filter((v) => v < LOW).length;
  const high = all.filter((v) => v > HIGH).length;
  const pct = (k: number) => (n ? (k / n) * 100 : 0);
  return {
    n,
    days: withData,
    mean,
    sd,
    cv: mean && sd !== null ? (sd / mean) * 100 : null,
    min: n ? Math.min(...all) : null,
    max: n ? Math.max(...all) : null,
    low,
    high,
    pctLow: pct(low),
    pctIn: pct(n - low - high),
    pctHigh: pct(high),
    rapidPerDay: avg(rapid),
    lentaPerDay: avg(lenta),
    rationsPerDay: avg(rations),
  };
}

/* ------------------------------------------------------------------ */

export interface Bucket extends Stats {
  key: string;
  label: string;
  /** Etiqueta larga para tablas y descripciones. */
  longLabel: string;
  from: string;
  to: string;
}

/** Semana y mes se dibujan por días; el año, por meses. */
export function buildBuckets(period: Period, range: DateRange, days: DayRecord[]): Bucket[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: Bucket[] = [];
  if (period === 'anio') {
    const year = strToDate(range.from).getFullYear();
    for (let m = 0; m < 12; m++) {
      const ym = `${year}-${pad(m + 1)}`;
      const last = new Date(year, m + 1, 0).getDate();
      const list: DayRecord[] = [];
      for (let d = 1; d <= last; d++) {
        const rec = byDate.get(`${ym}-${pad(d)}`);
        if (rec) list.push(rec);
      }
      out.push({ ...computeStats(list), key: ym, label: MONTHS_SHORT[m], longLabel: MONTHS[m], from: `${ym}-01`, to: `${ym}-${pad(last)}` });
    }
    return out;
  }
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
    const rec = byDate.get(date);
    const d = strToDate(date);
    const wd = WEEKDAYS[(d.getDay() + 6) % 7];
    out.push({
      ...computeStats(rec ? [rec] : []),
      key: date,
      label: period === 'semana' ? `${wd} ${d.getDate()}` : String(d.getDate()),
      longLabel: `${wd} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`,
      from: date,
      to: date,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */

export type Verdict = 'mejor' | 'peor' | 'igual';

export interface Comparison {
  label: string;
  now: string;
  before: string;
  delta: string;
  verdict: Verdict | null;
}

export interface Trend {
  /** Titular: mejora, empeora o estable (o que no hay datos para comparar). */
  headline: string;
  tone: 'ok' | 'atencion' | 'info';
  /** Sentido del titular: mejora, empeora o estable (null si no se puede comparar). */
  dir: 'mejor' | 'peor' | 'igual' | null;
  notes: string[];
  comparisons: Comparison[];
  /** Evolución dentro del propio periodo (primera mitad frente a la segunda), si hay datos suficientes. */
  inside: string | null;
}

const f0 = (n: number): string => Math.round(n).toLocaleString('es-ES');
const f1 = (n: number): string => n.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const sign = (n: number, f: (x: number) => string): string => (n > 0 ? '+' : n < 0 ? '−' : '') + f(Math.abs(n));

function cmp(
  label: string,
  now: number | null,
  before: number | null,
  fmt: (n: number) => string,
  unit: string,
  better: 'up' | 'down' | null,
  tol: number,
): Comparison {
  if (now === null || before === null) {
    return { label, now: now === null ? '—' : fmt(now) + unit, before: before === null ? '—' : fmt(before) + unit, delta: '—', verdict: null };
  }
  const d = now - before;
  let verdict: Verdict | null = null;
  if (better) verdict = Math.abs(d) < tol ? 'igual' : (d > 0) === (better === 'up') ? 'mejor' : 'peor';
  return { label, now: fmt(now) + unit, before: fmt(before) + unit, delta: sign(d, fmt) + unit, verdict };
}

/** Resume la tendencia respecto al periodo anterior y dentro del propio periodo. */
export function buildTrend(period: Period, current: DayRecord[], previous: DayRecord[]): Trend {
  const cur = computeStats(current);
  const prev = computeStats(previous);
  const what = period === 'semana' ? 'la semana anterior' : period === 'mes' ? 'el mes anterior' : 'el año anterior';
  const to = period === 'semana' ? 'a la semana anterior' : period === 'mes' ? 'al mes anterior' : 'al año anterior';

  const comparisons: Comparison[] = [
    cmp('Mediciones en rango (70–180)', cur.n ? cur.pctIn : null, prev.n ? prev.pctIn : null, f0, ' %', 'up', 3),
    cmp('Por debajo de 70', cur.n ? cur.pctLow : null, prev.n ? prev.pctLow : null, f1, ' %', 'down', 1),
    cmp('Por encima de 180', cur.n ? cur.pctHigh : null, prev.n ? prev.pctHigh : null, f0, ' %', 'down', 3),
    cmp('Glucemia media', cur.mean, prev.mean, f0, ' mg/dL', null, 0),
    cmp('Variabilidad (CV)', cur.cv, prev.cv, f0, ' %', 'down', 3),
    cmp('Insulina rápida por día', cur.rapidPerDay, prev.rapidPerDay, f1, ' U', null, 0),
  ];

  let headline: string;
  let tone: Trend['tone'] = 'info';
  let dir: Trend['dir'] = null;
  const notes: string[] = [];

  if (cur.n < MIN_READINGS) {
    headline = 'Aún hay pocas mediciones en este periodo para sacar conclusiones.';
  } else if (prev.n < MIN_READINGS) {
    headline = `No hay suficientes mediciones en ${what} para comparar.`;
  } else {
    const dIn = cur.pctIn - prev.pctIn;
    if (dIn >= 5) {
      headline = `Mejora: ${f0(cur.pctIn)} % de las mediciones en rango, ${f0(dIn)} puntos más que ${what}.`;
      tone = 'ok';
      dir = 'mejor';
    } else if (dIn <= -5) {
      headline = `Empeora: ${f0(cur.pctIn)} % de las mediciones en rango, ${f0(-dIn)} puntos menos que ${what}.`;
      tone = 'atencion';
      dir = 'peor';
    } else {
      dir = 'igual';
      headline = `Estable: ${f0(cur.pctIn)} % de las mediciones en rango, parecido ${to}.`;
    }
    const dLow = cur.low - prev.low;
    if (cur.low > 0) {
      notes.push(
        `${cur.low} ${cur.low === 1 ? 'medición' : 'mediciones'} por debajo de 70 mg/dL` +
          (prev.low ? ` (${prev.low} en ${what})` : '') +
          '. Conviene revisar cuándo ocurren.',
      );
      if (dLow > 0 && period !== 'anio') tone = 'atencion';
    } else {
      notes.push('Ninguna medición por debajo de 70 mg/dL.');
    }
    if (cur.mean !== null && prev.mean !== null && Math.abs(cur.mean - prev.mean) >= 10) {
      notes.push(`La glucemia media ${cur.mean > prev.mean ? 'sube' : 'baja'} ${f0(Math.abs(cur.mean - prev.mean))} mg/dL respecto ${to}.`);
    }
    if (cur.cv !== null && cur.cv > 36) notes.push(`Variabilidad alta (CV ${f0(cur.cv)} %): las glucemias oscilan mucho. La referencia habitual es por debajo del 36 %.`);
  }

  // Dentro del periodo: primera mitad frente a segunda mitad de las mediciones
  let inside: string | null = null;
  const dayList = [...current].sort((a, b) => a.date.localeCompare(b.date)).filter((d) => dayReadings(d).length);
  if (dayList.length >= 4) {
    const half = Math.floor(dayList.length / 2);
    const a = computeStats(dayList.slice(0, half));
    const b = computeStats(dayList.slice(dayList.length - half));
    if (a.n >= 6 && b.n >= 6 && a.mean !== null && b.mean !== null) {
      const d = b.mean - a.mean;
      const dr = b.pctIn - a.pctIn;
      if (Math.abs(dr) >= 8) inside = `Dentro del periodo, las mediciones en rango pasan del ${f0(a.pctIn)} % al ${f0(b.pctIn)} % (${dr > 0 ? 'mejora' : 'empeora'}).`;
      else if (Math.abs(d) >= 10) inside = `Dentro del periodo, la glucemia media ${d > 0 ? 'sube' : 'baja'} de ${f0(a.mean)} a ${f0(b.mean)} mg/dL.`;
      else inside = 'Dentro del periodo no se aprecia una tendencia clara.';
    }
  }

  return { headline, tone, dir, notes, comparisons, inside };
}
