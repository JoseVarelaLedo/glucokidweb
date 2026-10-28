import { Arrow, DayMark, DayRecord, Reading } from './models';

export type GlucoseClass = 'hipo' | 'tendHipo' | 'estable' | 'tendHiper' | 'hiper' | 'enRango' | 'alta';

export interface GlucoseInfo {
  cls: GlucoseClass;
  label: string;
  icon: string;
}

const UP: Arrow[] = ['up', 'upRight'];
const DOWN: Arrow[] = ['down', 'downRight'];

/**
 * Clasificación según las reglas pedidas:
 *  - < 70                              → hipoglucemia
 *  - 70–100 con flecha ↘ o ↓           → tendencia a hipoglucemia
 *  - 80–180 con flecha →               → glucemia estable
 *  - > 180 con flecha ↗ o ↑            → tendencia a hiperglucemia
 *  - > 350                             → hiperglucemia
 * Los casos que no encajan en ninguna regla se muestran como "En rango"
 * (70–180) o "Glucemia alta" (181–350 sin tendencia al alza).
 */
export function classify(value: number | null | undefined, arrow: Arrow | null | undefined): GlucoseInfo | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (value < 70) return { cls: 'hipo', label: 'Hipoglucemia', icon: '⚠' };
  if (value > 350) return { cls: 'hiper', label: 'Hiperglucemia', icon: '⚠' };
  if (value > 180 && arrow && UP.includes(arrow)) {
    return { cls: 'tendHiper', label: 'Tendencia a hiperglucemia', icon: '↗' };
  }
  if (value <= 100 && arrow && DOWN.includes(arrow)) {
    return { cls: 'tendHipo', label: 'Tendencia a hipoglucemia', icon: '↘' };
  }
  if (value >= 80 && value <= 180 && arrow === 'flat') {
    return { cls: 'estable', label: 'Glucemia estable', icon: '✓' };
  }
  if (value > 180) return { cls: 'alta', label: 'Glucemia alta', icon: '▲' };
  return { cls: 'enRango', label: 'En rango', icon: '•' };
}

function allReadings(day: DayRecord): Reading[] {
  const out: Reading[] = [];
  for (const m of day.meals) out.push(m.before, m.after);
  for (const x of day.extras) out.push(x);
  for (const a of day.activities) out.push(a.before, a.after);
  return out;
}

/** Resumen para el calendario: si el día tiene datos y si hubo hipo/hiperglucemia. */
export function dayMark(day: DayRecord): DayMark {
  const hasData =
    day.extras.length > 0 ||
    day.activities.length > 0 ||
    day.meals.some(
      (m) => m.before.value !== null || m.before.units !== null || m.items.length > 0 || m.after.value !== null,
    );
  let worst: DayMark['worst'] = null;
  for (const r of allReadings(day)) {
    const c = classify(r.value, r.arrow);
    if (c?.cls === 'hipo') return { hasData, worst: 'hipo' };
    if (c?.cls === 'hiper') worst = 'hiper';
  }
  return { hasData, worst };
}
