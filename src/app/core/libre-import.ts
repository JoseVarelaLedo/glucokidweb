/**
 * Serie continua del sensor (CSV del monitor) → `DayRecord.sensor`.
 * Cálculo puro. Solo se usa el historial automático; los escaneos, las tiras y los demás registros del archivo no se importan.
 */
import { GLU_MAX, GLU_MIN, LibreParse } from './libre-csv';

export const MAX_POINTS_PER_DAY = 1440;

/** Historial agrupado por día en el formato `[minuto, mg/dL, …]`. Se descartan los días posteriores a `today` (reloj mal puesto). */
export function seriesByDay(parse: LibreParse, today: string): Map<string, number[]> {
  const byDay = new Map<string, Map<number, number>>();
  for (const p of parse.history) {
    if (p.date > today) continue;
    let m = byDay.get(p.date);
    if (!m) byDay.set(p.date, (m = new Map()));
    m.set(p.min, p.value);
  }
  const out = new Map<string, number[]>();
  for (const [d, m] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) out.set(d, flatten(m));
  return out;
}

function flatten(m: Map<number, number>): number[] {
  const out: number[] = [];
  for (const k of [...m.keys()].sort((a, b) => a - b).slice(0, MAX_POINTS_PER_DAY)) out.push(k, m.get(k) as number);
  return out;
}

/** Lee una serie guardada ignorando lo que no sea un par de números válido. */
function toMap(s: readonly number[] | undefined): Map<number, number> {
  const m = new Map<number, number>();
  if (!Array.isArray(s)) return m;
  for (let i = 0; i + 1 < s.length; i += 2) {
    const t = s[i];
    const v = s[i + 1];
    if (Number.isFinite(t) && Number.isFinite(v) && t >= 0 && t < 1440 && v >= GLU_MIN && v <= GLU_MAX) m.set(t, v);
  }
  return m;
}

export interface Merge {
  merged: number[];
  /** Lecturas que no estaban. */
  added: number;
  /** Lecturas de la misma hora con otro valor (se sustituyen por las del archivo). */
  changed: number;
}

/** Une lo ya guardado con lo que llega. Importar dos veces el mismo archivo no cambia nada. */
export function mergeSeries(existing: readonly number[] | undefined, incoming: readonly number[]): Merge {
  const m = toMap(existing);
  let added = 0;
  let changed = 0;
  const inc = toMap(incoming);
  for (const [t, v] of inc) {
    const old = m.get(t);
    if (old === undefined) added++;
    else if (old !== v) changed++;
    m.set(t, v);
  }
  return { merged: flatten(m), added, changed };
}

export interface SeriesStats {
  n: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  /** % de lecturas entre 70 y 180 mg/dL. */
  inRange: number | null;
  /** % por debajo de 70. */
  low: number | null;
  /** % por encima de 180. */
  high: number | null;
}

export function seriesStats(s: readonly number[] | undefined, low = 70, high = 180): SeriesStats {
  const v = [...toMap(s).values()];
  if (!v.length) return { n: 0, mean: null, min: null, max: null, inRange: null, low: null, high: null };
  const pct = (k: number) => (k / v.length) * 100;
  return {
    n: v.length,
    mean: v.reduce((a, b) => a + b, 0) / v.length,
    min: Math.min(...v),
    max: Math.max(...v),
    inRange: pct(v.filter((x) => x >= low && x <= high).length),
    low: pct(v.filter((x) => x < low).length),
    high: pct(v.filter((x) => x > high).length),
  };
}

/** Puntos listos para dibujar, ordenados. */
export function seriesPoints(s: readonly number[] | undefined): Array<{ t: number; g: number }> {
  return [...toMap(s)].sort((a, b) => a[0] - b[0]).map(([t, g]) => ({ t, g }));
}
