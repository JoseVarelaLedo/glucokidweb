import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { CalcRow, CalcService } from '../../core/calc.service';
import { DataService } from '../../core/data.service';
import { CalcLine, CalcResult, carbsFor, computeDose } from '../../core/dose';
import { planTotal } from '../../core/defaults';
import { Food } from '../../core/models';
import { dayEvents, iobAt, correctionUnits, toMin } from '../../core/predict';
import { fmtNum, nowTime, todayStr } from '../../core/util';

@Component({
  selector: 'app-calculadora',
  imports: [FormsModule, RouterLink],
  templateUrl: './calculadora.html',
})
export class Calculadora implements OnInit {
  protected readonly data = inject(DataService);
  protected readonly calc = inject(CalcService);
  protected readonly fmt = fmtNum;

  protected readonly groups = computed(() => {
    const by = new Map<string, Food[]>();
    for (const f of this.data.foods()) {
      const list = by.get(f.group) ?? [];
      list.push(f);
      by.set(f.group, list);
    }
    return [...by.entries()].map(([name, foods]) => ({
      name,
      foods: [...foods].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    }));
  });

  protected targetId = this.rapidas()[0]?.id ?? '';
  /** Insulina rápida aún activa hoy (U), para avisar de acumulación al corregir. */
  protected readonly iobNow = signal<number | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      const day = await this.data.getDay(todayStr());
      const ev = dayEvents(day, this.data.settings(), this.data.foods());
      const now = toMin(nowTime());
      if (now !== null) this.iobNow.set(iobAt(ev, now, this.data.settings()));
    } catch {
      this.iobNow.set(null);
    }
  }

  /* ---------- corrección de hiperglucemia ---------- */

  protected targetValue(): number {
    return this.calc.target() ?? this.data.settings().targetGlucose ?? 150;
  }

  protected isf(): number {
    const v = this.data.settings().isf;
    return v && v > 0 ? v : 0;
  }

  /** null si faltan datos. */
  protected correction() {
    const cur = this.calc.current();
    if (cur === null || cur === undefined || Number.isNaN(cur) || cur <= 0 || !this.isf()) return null;
    return correctionUnits(cur, this.targetValue(), this.isf());
  }
  protected readonly message = signal('');
  protected readonly incomplete = signal(0);

  protected rapidas() {
    return this.data.settings().injections.filter((i) => i.kind === 'rapida');
  }

  private food(id: string): Food | undefined {
    return this.data.foods().find((f) => f.id === id);
  }

  protected rowCarbs(r: CalcRow): number | null {
    const f = this.food(r.foodId);
    if (!f || r.grams === null || r.grams < 0) return null;
    return carbsFor(f.carbsPer100g, r.grams);
  }

  /** Cambia si se tocan ingredientes, pesos o la relación configurada tras calcular. */
  private signature(): string {
    const s = this.data.settings();
    return JSON.stringify([
      this.calc.rows().map((r) => [r.foodId, r.grams]),
      s.gramsPerRation,
      s.unitsPerRation,
      s.doseStep,
      this.data.foods().map((f) => f.carbsPer100g),
    ]);
  }

  protected stale(): boolean {
    return this.calc.result() !== null && this.calc.snapshot !== this.signature();
  }

  protected calculate(): void {
    this.message.set('');
    const lines: CalcLine[] = [];
    let skipped = 0;
    for (const r of this.calc.rows()) {
      const f = this.food(r.foodId);
      if (!f || r.grams === null || r.grams < 0) {
        if (f || r.grams !== null) skipped++; // fila a medias (las totalmente vacías no cuentan)
        continue;
      }
      lines.push({ name: f.name, grams: r.grams, carbs: carbsFor(f.carbsPer100g, r.grams) });
    }
    this.incomplete.set(skipped);
    if (!lines.length) {
      this.calc.result.set(null);
      return;
    }
    const carbs = lines.reduce((acc, l) => acc + l.carbs, 0);
    const result: CalcResult = { lines, dose: computeDose(carbs, this.data.settings()) };
    this.calc.result.set(result);
    this.calc.snapshot = this.signature();
  }

  /** Hidratos de un alimento → raciones, redondeadas a media ración (mínimo media si lleva algo de hidratos). */
  private toRations(carbsGrams: number): number {
    const gpr = this.data.settings().gramsPerRation || 10;
    if (!(carbsGrams > 0)) return 0;
    return Math.max(0.5, Math.round((carbsGrams / gpr) * 2) / 2);
  }

  /** Raciones previstas para la comida elegida como destino (Ajustes), o null. */
  protected targetPlan(): { name: string; harinas: number; verduras: number; fruta: number; total: number } | null {
    const inj = this.rapidas().find((i) => i.id === this.targetId);
    const total = planTotal(inj?.plan);
    if (!inj || total <= 0) return null;
    return { name: inj.name, harinas: inj.plan?.harinas ?? 0, verduras: inj.plan?.verduras ?? 0, fruta: inj.plan?.fruta ?? 0, total };
  }

  protected async transfer(res: CalcResult): Promise<void> {
    if (!this.targetId) return;
    const ok = await this.data.applyCalculation(
      todayStr(),
      this.targetId,
      res.dose.roundedUnits,
      res.lines.map((l) => ({ name: l.name, quantity: `${fmtNum(l.grams)} g`, rations: this.toRations(l.carbs) })),
    );
    const name = this.rapidas().find((i) => i.id === this.targetId)?.name ?? 'la comida';
    this.message.set(
      ok
        ? `Añadido al registro de hoy (${name}): ${fmtNum(res.dose.roundedUnits)} U y los alimentos.`
        : 'No se ha podido añadir: esa administración no existe en el registro de hoy.',
    );
  }
}
