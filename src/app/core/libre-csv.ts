/**
 * Lectura del CSV que exporta el monitor (FreeStyle Libre / LibreView, en español o inglés).
 *
 * Es cálculo puro, sin Angular. Solo se leen las columnas de glucosa, la marca de tiempo y el tipo de registro: la primera línea del
 * archivo («Generado por …») lleva el nombre del niño y se descarta sin leerla, así que nunca se guarda ni se muestra.
 */

export const MAX_CSV_BYTES = 8 * 1024 * 1024;
export const MAX_CSV_ROWS = 60000;
/** Rango de glucosa aceptado (el sensor mide 40–400; se admite algo de margen). */
export const GLU_MIN = 20;
export const GLU_MAX = 600;

/** Un punto con la hora del reloj del dispositivo. `t` son minutos desde 1970 contando la hora local como si fuera UTC (solo sirve para restar). */
export interface LibrePoint {
  date: string; // AAAA-MM-DD
  min: number; // minutos desde las 00:00
  t: number;
  value: number;
}

export interface LibreParse {
  /** Historial automático (cada 5–15 min). */
  history: LibrePoint[];
  /** Escaneos manuales del sensor. */
  scans: LibrePoint[];
  /** Glucemias capilares (tira reactiva) que se anotaron en el lector o la app. */
  strips: LibrePoint[];
  /** Fechas con un «evento» del sensor (tipo 6; normalmente arranque o cambio de sensor). */
  eventDates: string[];
  rows: number;
  /** Filas con datos de glucosa que no se pudieron entender (fecha o valor ilegibles, o fuera de rango). */
  ignored: number;
  first: string;
  last: string;
  unit: 'mg/dL' | 'mmol/L';
}

export class LibreCsvError extends Error {}

/** Decodifica el archivo: UTF-8 y, si no lo es, Windows-1252 (el que usa LibreView en español). */
export function decodeCsv(buf: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Lector CSV con comillas (RFC 4180). */
function parseRows(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
      if (rows.length > MAX_CSV_ROWS + 10) throw new LibreCsvError('El archivo tiene demasiadas filas.');
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Nombres de columna conocidos (sin tildes ni mayúsculas) en español e inglés. */
const COL = {
  ts: ['sello de tiempo del dispositivo', 'device timestamp', 'marca de tiempo del dispositivo'],
  type: ['tipo de registro', 'record type'],
  hist: ['historial de glucosa mg/dl', 'historic glucose mg/dl', 'historial de glucosa mmol/l', 'historic glucose mmol/l'],
  scan: ['escaneo de glucosa mg/dl', 'scan glucose mg/dl', 'escaneo de glucosa mmol/l', 'scan glucose mmol/l'],
  strip: ['tira reactiva para glucosa mg/dl', 'strip glucose mg/dl', 'tira reactiva para glucosa mmol/l', 'strip glucose mmol/l'],
};

function findCol(header: string[], names: string[]): number {
  const h = header.map(norm);
  for (const n of names) {
    const i = h.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

const pad = (n: number): string => String(n).padStart(2, '0');

interface Stamp {
  y: number;
  a: number; // primer número (día o mes)
  b: number; // segundo número
  iso: boolean;
  h: number;
  mi: number;
}

function parseStamp(s: string): Stamp | null {
  const t = s.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (m) return { y: +m[1], a: +m[2], b: +m[3], iso: true, h: +m[4], mi: +m[5] };
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?$/.exec(t);
  if (!m) return null;
  let h = +m[4];
  if (m[6]) {
    const pm = /^p/i.test(m[6]);
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (pm ? 12 : 0);
  }
  return { y: +m[3], a: +m[1], b: +m[2], iso: false, h, mi: +m[5] };
}

function toPoint(st: Stamp, dayFirst: boolean, value: number): LibrePoint | null {
  const day = st.iso ? st.b : dayFirst ? st.a : st.b;
  const mon = st.iso ? st.a : dayFirst ? st.b : st.a;
  if (mon < 1 || mon > 12 || day < 1 || day > 31 || st.h > 23 || st.mi > 59) return null;
  const ms = Date.UTC(st.y, mon - 1, day, st.h, st.mi);
  const d = new Date(ms);
  // fechas imposibles (31 de febrero…) se desplazan: las descartamos
  if (d.getUTCMonth() !== mon - 1 || d.getUTCDate() !== day) return null;
  return { date: `${st.y}-${pad(mon)}-${pad(day)}`, min: st.h * 60 + st.mi, t: Math.round(ms / 60000), value };
}

function num(s: string | undefined, mmol: boolean): number | null {
  if (s === undefined) return null;
  const t = s.trim().replace(',', '.');
  if (t === '' || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const v = parseFloat(t);
  return mmol ? Math.round(v * 18.016) : Math.round(v);
}

export function parseLibreCsv(text: string): LibreParse {
  // Se busca la fila de cabecera entre las primeras (la primera línea es un título con el nombre del niño y no se usa).
  const lines = text.split(/\r\n|\n|\r/, 8);
  let delim = ',';
  let headerAt = -1;
  for (let i = 0; i < Math.min(lines.length, 6); i++) {
    const n = norm(lines[i]);
    if (COL.ts.some((c) => n.includes(c))) {
      headerAt = i;
      delim = (lines[i].match(/;/g)?.length ?? 0) > (lines[i].match(/,/g)?.length ?? 0) ? ';' : (lines[i].match(/\t/g)?.length ?? 0) > 5 ? '\t' : ',';
      break;
    }
  }
  if (headerAt < 0) throw new LibreCsvError('No parece un archivo exportado del monitor: no se encuentra la columna con la fecha y hora.');

  // Quitamos las líneas anteriores a la cabecera sin analizarlas.
  let offset = 0;
  for (let i = 0; i < headerAt; i++) {
    const m = /\r\n|\n|\r/.exec(text.slice(offset));
    offset += m ? m.index + m[0].length : text.length;
  }
  const rows = parseRows(text.slice(offset), delim);
  const header = rows[0] ?? [];
  const iTs = findCol(header, COL.ts);
  const iType = findCol(header, COL.type);
  const iHist = findCol(header, COL.hist);
  const iScan = findCol(header, COL.scan);
  const iStrip = findCol(header, COL.strip);
  if (iTs < 0 || iType < 0 || (iHist < 0 && iScan < 0 && iStrip < 0)) {
    throw new LibreCsvError('Faltan columnas de glucosa o el tipo de registro. ¿Es la exportación de datos de glucosa?');
  }
  const mmol = [iHist, iScan, iStrip].some((i) => i >= 0 && /mmol/.test(norm(header[i])));

  const body = rows.slice(1).filter((r) => r.some((c) => c.trim() !== ''));
  // ¿día/mes o mes/día? Si algún primer número pasa de 12 es día primero; si lo pasa el segundo, mes primero.
  let dayFirst = true;
  for (const r of body) {
    const st = parseStamp(r[iTs] ?? '');
    if (!st || st.iso) continue;
    if (st.a > 12) {
      dayFirst = true;
      break;
    }
    if (st.b > 12) {
      dayFirst = false;
      break;
    }
  }

  const out: LibreParse = {
    history: [],
    scans: [],
    strips: [],
    eventDates: [],
    rows: body.length,
    ignored: 0,
    first: '',
    last: '',
    unit: mmol ? 'mmol/L' : 'mg/dL',
  };
  const events = new Set<string>();
  const seen = new Set<string>();
  for (const r of body) {
    const type = (r[iType] ?? '').trim();
    const cols: Array<[number, LibrePoint[]]> = [
      [iHist, out.history],
      [iScan, out.scans],
      [iStrip, out.strips],
    ];
    // tipo 0 = historial, 1 = escaneo, 2 = tira; pero se manda por la columna con valor (más robusto ante cambios de numeración)
    let any = false;
    for (const [ci, list] of cols) {
      if (ci < 0) continue;
      const raw = (r[ci] ?? '').trim();
      if (raw === '') continue;
      any = true;
      const v = num(raw, mmol);
      const st = parseStamp(r[iTs] ?? '');
      const p = v !== null && v >= GLU_MIN && v <= GLU_MAX && st ? toPoint(st, dayFirst, v) : null;
      if (!p) {
        out.ignored++;
        continue;
      }
      const key = `${ci}|${p.t}|${p.value}`;
      if (seen.has(key)) continue; // el mismo dato puede venir repetido (lector y app)
      seen.add(key);
      list.push(p);
    }
    if (!any && type === '6') {
      const st = parseStamp(r[iTs] ?? '');
      const p = st ? toPoint(st, dayFirst, 0) : null;
      if (p) events.add(p.date);
    }
  }
  for (const l of [out.history, out.scans, out.strips]) l.sort((a, b) => a.t - b.t);
  const all = [...out.history, ...out.scans, ...out.strips];
  if (!all.length) throw new LibreCsvError(out.ignored ? 'No se ha podido leer ninguna glucosa del archivo (fechas o valores ilegibles).' : 'El archivo no contiene lecturas de glucosa.');
  out.first = all.reduce((m, p) => (p.date < m ? p.date : m), all[0].date);
  out.last = all.reduce((m, p) => (p.date > m ? p.date : m), all[0].date);
  out.eventDates = [...events].sort();
  return out;
}
