export const pad = (n: number): string => String(n).padStart(2, '0');

/** Fecha local en formato YYYY-MM-DD (no UTC, para que "hoy" sea el de verdad). */
export function dateToStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayStr(): string {
  return dateToStr(new Date());
}

export function strToDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s: string, n: number): string {
  const d = strToDate(s);
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}

export function nowTime(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function uid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function round(n: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

/** Formato español: 4,5 */
export function fmtNum(n: number | null | undefined, maxDecimals = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('es-ES', { maximumFractionDigits: maxDecimals });
}

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** JSON con las claves ordenadas: sirve para comparar objetos aunque Firestore reordene los campos. */
export function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

/** "Menú del colegio" → "menu-del-colegio" */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'documento'
  );
}
