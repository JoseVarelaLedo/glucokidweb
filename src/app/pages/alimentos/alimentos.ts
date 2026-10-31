import { Component, DoCheck, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AutoSave } from '../../core/autosave';
import { DataService } from '../../core/data.service';
import { FOOD_GROUPS } from '../../core/defaults';
import { Food } from '../../core/models';
import { ImportPreview, MAX_FILE_BYTES, applyImport, foodsToJson, parseFoodsJson } from '../../core/foods-io';
import { fmtNum, round, todayStr, uid } from '../../core/util';

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

  /* ---------------- importar / exportar JSON ---------------- */
  protected readonly preview = signal<ImportPreview | null>(null);
  protected readonly importName = signal('');
  protected readonly importMode = signal<'mezclar' | 'reemplazar'>('mezclar');
  protected readonly ioMsg = signal('');

  protected exportFoods(): void {
    const json = foodsToJson(this.data.foods(), this.gramsPerRation());
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `glucokid-alimentos-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.ioMsg.set(`Exportados ${this.data.foods().length} alimentos.`);
  }

  protected async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // permite volver a elegir el mismo archivo
    this.ioMsg.set('');
    if (!file) return;
    this.importName.set(file.name);
    if (file.size > MAX_FILE_BYTES) {
      this.preview.set({ items: [], errors: ['El archivo es demasiado grande (máximo 1 MB).'], warnings: [], counts: { nuevo: 0, actualiza: 0, igual: 0 } });
      return;
    }
    this.preview.set(parseFoodsJson(await file.text(), this.data.foods(), this.gramsPerRation()));
  }

  protected applyImport(): void {
    const p = this.preview();
    if (!p || !p.items.length) return;
    const mode = this.importMode();
    if (mode === 'reemplazar' && !confirm(`Se sustituirá todo el catálogo (${this.data.foods().length} alimentos) por los ${p.items.length} del archivo. ¿Continuar?`)) return;
    this.data.foods.set(applyImport(this.data.foods(), p, mode));
    this.ioMsg.set(
      mode === 'reemplazar'
        ? `Catálogo sustituido: ${p.items.length} alimentos.`
        : `Importado: ${p.counts.nuevo} nuevos y ${p.counts.actualiza} actualizados.`,
    );
    this.selectedId.set('');
    this.preview.set(null);
  }

  protected cancelImport(): void {
    this.preview.set(null);
  }

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

  /** Gramos de hidratos de una ración (Ajustes; 10 g por defecto). */
  protected gramsPerRation(): number {
    return this.data.settings().gramsPerRation || 10;
  }

  /** Gramos de ESTE alimento que equivalen a una ración (null si no tiene hidratos). */
  protected rationGrams(f: Food): number | null {
    return f.carbsPer100g > 0 ? round((this.gramsPerRation() * 100) / f.carbsPer100g, 1) : null;
  }

  /** Al editar «gramos por ración» se recalculan los hidratos por 100 g (que es lo que guarda el catálogo). */
  protected setRationGrams(f: Food, value: number | null): void {
    if (value === null || Number.isNaN(value) || value <= 0) return;
    f.carbsPer100g = round((this.gramsPerRation() * 100) / value, 4);
  }

  protected rationsAtRef(f: Food): number {
    const g = this.data.settings().gramsPerRation || 10;
    return (f.carbsPer100g * this.refGrams()) / 100 / g;
  }
}
