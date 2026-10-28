import { Component, DoCheck, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AutoSave } from '../../core/autosave';
import { DataService } from '../../core/data.service';
import { FOOD_GROUPS } from '../../core/defaults';
import { Food } from '../../core/models';
import { fmtNum, round, uid } from '../../core/util';

@Component({
  selector: 'app-alimentos',
  imports: [FormsModule],
  templateUrl: './alimentos.html',
})
export class Alimentos implements DoCheck, OnDestroy {
  protected readonly data = inject(DataService);
  protected readonly fmt = fmtNum;
  protected readonly groupNames: readonly string[] = FOOD_GROUPS;

  protected readonly query = signal('');
  protected readonly selectedId = signal('');
  /** Cantidad de referencia del control gradual (10–100 g). */
  protected readonly refGrams = signal(100);

  protected readonly sel = computed<Food | undefined>(() => this.data.foods().find((f) => f.id === this.selectedId()));

  private readonly auto = new AutoSave<Food[]>(
    () => this.data.foods(),
    (f) => this.data.saveFoods(f),
  );

  constructor() {
    this.auto.reset(this.data.foods());
  }

  ngDoCheck(): void {
    this.auto.check();
  }

  ngOnDestroy(): void {
    void this.auto.flush();
  }

  /** Lista filtrada y agrupada. Es un método (no computed) porque los nombres/grupos se editan "in situ". */
  protected groups(): Array<{ name: string; foods: Food[] }> {
    const q = this.query().trim().toLowerCase();
    const by = new Map<string, Food[]>();
    for (const f of this.data.foods()) {
      if (q && !f.name.toLowerCase().includes(q)) continue;
      const list = by.get(f.group) ?? [];
      list.push(f);
      by.set(f.group, list);
    }
    const order = (g: string) => {
      const i = this.groupNames.indexOf(g);
      return i < 0 ? 99 : i;
    };
    return [...by.entries()]
      .sort((a, b) => order(a[0]) - order(b[0]))
      .map(([name, foods]) => ({ name, foods: [...foods].sort((a, b) => a.name.localeCompare(b.name, 'es')) }));
  }

  protected select(f: Food): void {
    this.selectedId.set(f.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  protected add(): void {
    const f: Food = { id: uid(), name: 'Nuevo alimento', group: 'Otros', carbsPer100g: 0 };
    this.data.foods.update((list) => [...list, f]);
    this.query.set('');
    this.select(f);
  }

  protected remove(f: Food): void {
    if (!confirm(`¿Eliminar «${f.name}» del catálogo?`)) return;
    this.data.foods.update((list) => list.filter((x) => x.id !== f.id));
    this.selectedId.set('');
  }

  /** Hidratos que aporta la cantidad de referencia elegida con el control gradual. */
  protected carbsAtRef(f: Food): number {
    return round((f.carbsPer100g * this.refGrams()) / 100, 2);
  }

  protected setCarbsAtRef(f: Food, value: number | null): void {
    const v = value === null || Number.isNaN(value) || value < 0 ? 0 : value;
    f.carbsPer100g = round((v * 100) / this.refGrams(), 4);
  }

  protected rationsAtRef(f: Food): number {
    const g = this.data.settings().gramsPerRation || 10;
    return (f.carbsPer100g * this.refGrams()) / 100 / g;
  }
}
