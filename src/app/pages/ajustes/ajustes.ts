import { Component, DoCheck, OnDestroy, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AlertsService } from '../../core/alerts.service';
import { AuthService } from '../../core/auth.service';
import { PushService } from '../../core/push.service';
import { AutoSave } from '../../core/autosave';
import { DataService } from '../../core/data.service';
import { InjectionDef, RationPlan, Settings } from '../../core/models';
import { fmtNum, round, uid } from '../../core/util';
import { makeDefaultModel, planTotal } from '../../core/defaults';
import { ISF_RULE, carbRatioHint, sensitivityFactor } from '../../core/predict';

@Component({
  selector: 'app-ajustes',
  imports: [FormsModule],
  templateUrl: './ajustes.html',
})
export class Ajustes implements DoCheck, OnDestroy {
  protected readonly data = inject(DataService);
  protected readonly auth = inject(AuthService);
  protected readonly alerts = inject(AlertsService);
  protected readonly push = inject(PushService);
  protected readonly fmt = fmtNum;
  protected readonly isfMsg = signal('');
  protected readonly backupBusy = signal(false);
  protected readonly backupMsg = signal('');

  private readonly auto = new AutoSave<Settings>(
    () => (this.valid() ? this.data.settings() : null),
    (s) => this.data.saveSettings(s),
  );

  constructor() {
    this.auto.reset(this.data.settings());
  }

  ngDoCheck(): void {
    this.auto.check();
  }

  ngOnDestroy(): void {
    void this.auto.flush();
  }

  /** Solo se guarda cuando la configuración es coherente. */
  protected valid(): boolean {
    const s = this.data.settings();
    return (
      s.injections.length > 0 &&
      s.injections.every((i) => i.name.trim().length > 0 && i.maxUnits > 0 && (i.defaultUnits == null || (i.defaultUnits >= 0 && i.defaultUnits <= i.maxUnits)) && planTotal(i.plan) <= 100) &&
      s.gramsPerRation > 0 &&
      s.unitsPerRation >= 0 &&
      s.doseStep > 0
    );
  }

  /** Opciones de "unidades por defecto": de 0 hasta el máximo, con el escalón configurado. */
  protected defaultOptions(inj: InjectionDef): number[] {
    const step = this.data.settings().doseStep || 0.5;
    const max = Math.min(Math.max(inj.maxUnits || 0, 0), 100);
    const out: number[] = [];
    for (let i = 1; i <= Math.round(max / step); i++) out.push(round(i * step, 2));
    const cur = inj.defaultUnits;
    if (cur != null && cur > 0 && !out.includes(cur)) out.push(cur);
    return out.sort((a, b) => a - b);
  }

  /** Opciones para las raciones previstas: de media en media, hasta 20. */
  protected readonly planOptions = Array.from({ length: 40 }, (_, i) => (i + 1) * 0.5);

  protected planValue(inj: InjectionDef, k: keyof RationPlan): number | null {
    return inj.plan?.[k] ?? null;
  }

  protected setPlan(inj: InjectionDef, k: keyof RationPlan, v: number | null): void {
    inj.plan = { ...(inj.plan ?? {}), [k]: v };
  }

  /** Total de raciones previstas al día (solo comidas con insulina rápida) y gramos de hidratos que suponen. */
  protected dayPlan(): { rations: number; grams: number } | null {
    const s = this.data.settings();
    const rations = s.injections.filter((i) => i.kind === 'rapida').reduce((acc, i) => acc + planTotal(i.plan), 0);
    return rations > 0 ? { rations, grams: rations * (s.gramsPerRation || 10) } : null;
  }

  protected carbReference(): number | null {
    const s = this.data.settings();
    return s.dailyCalories && s.dailyCalories > 0 && s.carbPercent ? (s.dailyCalories * (s.carbPercent / 100)) / 4 : null;
  }

  protected addInjection(): void {
    this.data.settings().injections.push({ id: uid(), name: 'Nueva administración', kind: 'rapida', maxUnits: 20, defaultUnits: null });
  }

  protected removeInjection(i: number): void {
    const s = this.data.settings();
    if (s.injections.length <= 1) return;
    if (confirm(`¿Quitar «${s.injections[i].name}»? Los días ya registrados conservan sus datos.`)) {
      s.injections.splice(i, 1);
    }
  }

  protected move(i: number, dir: -1 | 1): void {
    const list = this.data.settings().injections;
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  }

  /* ---------- calorías ---------- */

  protected carbGramsPerDay(): number | null {
    const s = this.data.settings();
    if (!s.dailyCalories || s.dailyCalories <= 0 || !s.carbPercent) return null;
    return (s.dailyCalories * (s.carbPercent / 100)) / 4; // 4 kcal por gramo de hidratos
  }

  protected rationsPerDay(): number | null {
    const g = this.carbGramsPerDay();
    const gpr = this.data.settings().gramsPerRation;
    return g === null || !gpr ? null : g / gpr;
  }

  /* ---------- factor de sensibilidad ---------- */

  protected totalDaily(): number {
    const s = this.data.settings();
    return (s.dailyRapid || 0) + (s.dailyLenta || 0);
  }

  protected ratioHint(): number | null {
    return carbRatioHint(this.totalDaily());
  }

  protected calcIsf(): void {
    const s = this.data.settings();
    const r = sensitivityFactor(s.dailyRapid || 0, s.dailyLenta || 0);
    if (!r) {
      this.isfMsg.set('Introduce las unidades diarias de rápida y/o lenta para calcularlo.');
      return;
    }
    s.isf = r.isf;
    this.isfMsg.set(`Factor de sensibilidad calculado y guardado: 1 U baja ≈ ${fmtNum(r.isf, 1)} mg/dL (${ISF_RULE} ÷ ${fmtNum(r.total, 1)} U al día).`);
  }

  /* ---------- modelo predictivo ---------- */

  protected resetModel(): void {
    this.data.settings().model = makeDefaultModel();
  }

  /* ---------- copia de seguridad ---------- */

  protected async backup(): Promise<void> {
    this.backupBusy.set(true);
    this.backupMsg.set('');
    try {
      const blob = await this.data.exportAll();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `glucokid-copia-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      this.backupMsg.set('Copia descargada. Guárdala en un lugar seguro (contiene datos de salud).');
    } catch (e) {
      this.backupMsg.set('No se ha podido generar la copia. ' + (e instanceof Error ? e.message : ''));
    } finally {
      this.backupBusy.set(false);
    }
  }
}
