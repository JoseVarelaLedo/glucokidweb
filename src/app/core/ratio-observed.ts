/**
 * Relación unidades/ración que se ha puesto de verdad, a partir de lo anotado.
 *
 * Cálculo puro y solo informativo: no cambia ningún ajuste ni dosis. Para cada comida de insulina rápida con unidades y raciones de
 * hidratos anotadas se divide unidades ÷ raciones; después se toma la mediana por comida (desayuno, comida…), que no se deja arrastrar
 * por un día raro. Se descartan las comidas con glucemia previa por encima de 180 mg/dL, porque en ellas la dosis puede incluir una
 * corrección y la relación saldría inflada.
 */
import { median } from './calibration';
import { DayRecord, Food, InjectionDef } from './models';
import { mealRations } from './predict';
import { quantile } from './predictor-eval';

export const OBS_DAYS = 30;
/** Comidas mínimas para fiarse de la mediana de una comida. */
export const OBS_MIN = 5;
/** Glucemia previa a partir de la cual la dosis puede llevar corrección y se descarta la comida. */
export const OBS_MAX_PRE = 180;

export interface ObservedRatio {
  id: string;
  name: string;
  /** Comidas usadas. */
  n: number;
  /** Mediana de unidades por ración y su inverso (raciones que cubre 1 U). */
  unitsPerRation: number;
  rationsPerUnit: number;
  /** Mitad central de los días (cuartiles). */
  p25: number;
  p75: number;
  enough: boolean;
}

export interface ObservedSummary {
  meals: ObservedRatio[];
  /** Todas las comidas juntas: unidades totales ÷ raciones totales. */
  global: { n: number; unitsPerRation: number; rationsPerUnit: number } | null;
  /** Comidas con unidades y raciones anotadas que se descartaron por glucemia previa alta. */
  excludedHigh: number;
}

export function observedRatios(days: DayRecord[], from: string, to: string, foods: Food[], injections: InjectionDef[]): ObservedSummary {
  const byId = new Map<string, { name: string; ratios: number[] }>();
  let units = 0;
  let rations = 0;
  let n = 0;
  let excludedHigh = 0;
  for (const d of days) {
    if (d.date < from || d.date > to) continue;
    for (const m of d.meals ?? []) {
      if (m.kind !== 'rapida') continue;
      const u = m.before?.units;
      if (typeof u !== 'number' || !Number.isFinite(u) || u <= 0) continue;
      const r = mealRations(m, foods);
      if (!(r > 0)) continue;
      const pre = m.before?.value;
      if (typeof pre === 'number' && pre > OBS_MAX_PRE) {
        excludedHigh++;
        continue;
      }
      const e = byId.get(m.injectionId) ?? { name: m.name, ratios: [] };
      e.ratios.push(u / r);
      byId.set(m.injectionId, e);
      units += u;
      rations += r;
      n++;
    }
  }
  const order = (id: string): number => {
    const i = injections.findIndex((x) => x.id === id);
    return i < 0 ? 1e6 : i;
  };
  const meals: ObservedRatio[] = [...byId.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([id, e]) => {
      const s = [...e.ratios].sort((x, y) => x - y);
      const med = median(s);
      return {
        id,
        name: injections.find((x) => x.id === id)?.name ?? e.name,
        n: s.length,
        unitsPerRation: med,
        rationsPerUnit: med > 0 ? 1 / med : 0,
        p25: quantile(s, 0.25),
        p75: quantile(s, 0.75),
        enough: s.length >= OBS_MIN,
      };
    });
  return {
    meals,
    global: n && rations > 0 ? { n, unitsPerRation: units / rations, rationsPerUnit: rations / units } : null,
    excludedHigh,
  };
}
