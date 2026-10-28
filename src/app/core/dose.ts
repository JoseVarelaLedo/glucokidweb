import { Settings } from './models';
import { round } from './util';

/**
 * Ajuste adicional sobre la dosis base (en unidades, positivo o negativo).
 * Aquí se enchufarán en el futuro los factores de corrección
 * (p. ej. corrección por glucemia alta, ejercicio, etc.).
 */
export interface DoseAdjustment {
  label: string;
  units: number;
}

export interface DoseResult {
  carbsGrams: number;
  rations: number;
  baseUnits: number;
  adjustments: DoseAdjustment[];
  totalUnits: number;
  roundedUnits: number;
  step: number;
}

export interface CalcLine {
  name: string;
  grams: number;
  carbs: number;
}

export interface CalcResult {
  lines: CalcLine[];
  dose: DoseResult;
}

type DoseSettings = Pick<Settings, 'gramsPerRation' | 'unitsPerRation' | 'doseStep'>;

export function computeDose(carbsGrams: number, s: DoseSettings, adjustments: DoseAdjustment[] = []): DoseResult {
  const gramsPerRation = s.gramsPerRation > 0 ? s.gramsPerRation : 10;
  const unitsPerRation = s.unitsPerRation >= 0 ? s.unitsPerRation : 1;
  const step = s.doseStep > 0 ? s.doseStep : 0.5;

  const rations = carbsGrams / gramsPerRation;
  const baseUnits = rations * unitsPerRation;
  const totalUnits = baseUnits + adjustments.reduce((acc, a) => acc + a.units, 0);
  const roundedUnits = Math.max(0, round(Math.round(totalUnits / step) * step, 2));

  return { carbsGrams, rations, baseUnits, adjustments, totalUnits, roundedUnits, step };
}

export function carbsFor(carbsPer100g: number, grams: number): number {
  return (carbsPer100g * grams) / 100;
}
