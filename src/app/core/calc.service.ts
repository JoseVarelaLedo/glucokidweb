import { Injectable, signal } from '@angular/core';
import { CalcResult } from './dose';
import { uid } from './util';

export interface CalcRow {
  id: string;
  foodId: string;
  grams: number | null;
}

export const newCalcRow = (): CalcRow => ({ id: uid(), foodId: '', grams: null });

/** Conserva los ingredientes y el resultado al cambiar de pestaña. */
@Injectable({ providedIn: 'root' })
export class CalcService {
  readonly rows = signal<CalcRow[]>([newCalcRow()]);
  readonly result = signal<CalcResult | null>(null);
  snapshot = '';
  /** Pestaña activa de la calculadora. */
  readonly tab = signal<'comida' | 'correccion' | 'regla'>('comida');
  /** Corrección de hiperglucemia: glucemia medida ahora y objetivo (null = usar el de Ajustes). */
  readonly current = signal<number | null>(null);
  readonly target = signal<number | null>(null);

  add(): void {
    this.rows.update((r) => [...r, newCalcRow()]);
  }

  remove(id: string): void {
    this.rows.update((r) => {
      const next = r.filter((x) => x.id !== id);
      return next.length ? next : [newCalcRow()];
    });
  }

  clear(): void {
    this.rows.set([newCalcRow()]);
    this.result.set(null);
    this.snapshot = '';
    this.current.set(null);
    this.target.set(null);
  }
}
