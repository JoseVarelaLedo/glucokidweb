import { Component, DoCheck, HostListener, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AlertsService } from '../../core/alerts.service';
import { AutoSave } from '../../core/autosave';
import { DataService } from '../../core/data.service';
import { dayMark } from '../../core/glucose';
import { LayoutService } from '../../core/layout.service';
import { Activity, DayMark, DayRecord, ExtraReading, FoodEntry, Meal, RationPlan } from '../../core/models';
import { addDays, canon, fmtNum, isClosedDay, nowTime, round, strToDate, todayStr, uid } from '../../core/util';
import { AuthService } from '../../core/auth.service';
import { emptyReading, planTotal } from '../../core/defaults';
import { findFood } from '../../core/predict';
import { Calendar } from '../../shared/calendar';
import { FoodPicker } from '../../shared/food-picker';
import { DayCurve } from '../../shared/day-curve';
import { DaySnapshot } from '../../shared/day-snapshot';
import { Evolution } from '../../shared/evolution';
import { MonitorPanel } from '../../shared/monitor-panel';
import { sensorDayOf } from '../../core/calibration';
import { Period } from '../../core/evolution';
import { ReadingEditor } from '../../shared/reading-editor';

const ACTIVITY_SUGGESTIONS = [
  'Fútbol',
  'Baloncesto',
  'Natación',
  'Bicicleta',
  'Paseo',
  'Carrera',
  'Educación física colegio',
  'Baile',
  'Parque / juego libre',
  'Cumpleaños recinto juegos'
];

@Component({
  selector: 'app-registro',
  imports: [FormsModule, Calendar, ReadingEditor, DayCurve, FoodPicker, DaySnapshot, Evolution, MonitorPanel],
  templateUrl: './registro.html',
})
export class Registro implements OnInit, DoCheck, OnDestroy {
  protected readonly data = inject(DataService);
  protected readonly layout = inject(LayoutService);
  private readonly alerts = inject(AlertsService);
  private readonly auth = inject(AuthService);

  protected readonly date = signal(todayStr());
  protected day: DayRecord | null = null;
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly calendarOpen = signal(false);
  protected readonly curveOpen = signal(false);
  /** Vista: el día o la evolución por semanas, meses o año. */
  protected readonly view = signal<'dia' | Period | 'monitor'>('dia');
  protected readonly views: ReadonlyArray<{ key: 'dia' | Period | 'monitor'; label: string }> = [
    { key: 'dia', label: 'Día' },
    { key: 'semana', label: 'Semana' },
    { key: 'mes', label: 'Mes' },
    { key: 'anio', label: 'Año' },
    { key: 'monitor', label: 'Monitor' },
  ];
  protected period(): Period {
    const v = this.view();
    return v === 'semana' || v === 'mes' || v === 'anio' ? v : 'semana';
  }

  /** Día de vida del sensor del monitor en la fecha mostrada (si se anotó el cambio de sensor). */
  protected sensorDay(): number | null {
    return sensorDayOf(this.date(), this.data.settings().sensors);
  }
  /** Fecha de un día cerrado que un administrador ha reabierto para corregirlo (solo mientras se está en él). */
  private readonly reopened = signal('');
  protected readonly marks = signal<Record<string, DayMark>>({});
  protected readonly openIds = signal<ReadonlySet<string>>(new Set());
  protected readonly activitySuggestions = ACTIVITY_SUGGESTIONS;
  protected readonly fmt = fmtNum;
  protected readonly today = todayStr;

  private readonly loadedMonths = new Set<string>();
  private seq = 0;
  private readonly unitCache = new Map<string, number[]>();
  private readonly auto = new AutoSave<DayRecord>(
    () => this.day,
    async (d) => {
      await this.data.saveDay(d);
      this.setMark(d);
      // avisa a los demás cuidadores si hay una lectura de hipo/hiperglucemia nueva
      void this.alerts.check(d);
    },
  );
  private unwatch?: () => void;
  /** Comidas cuya glucemia ya estaba anotada (o ya se procesó): solo se propone la dosis la primera vez que se anota. */
  private readonly valueSeen = new Set<string>();

  ngOnInit(): void {
    void this.goTo(todayStr());
  }

  ngDoCheck(): void {
    this.applyDefaultUnits();
    this.auto.check();
  }

  ngOnDestroy(): void {
    this.unwatch?.();
    void this.auto.flush();
  }

  /** En el móvil, al pasar a segundo plano o cerrar la pestaña, guardamos lo pendiente. */
  @HostListener('document:visibilitychange')
  @HostListener('window:pagehide')
  protected onHide(): void {
    void this.auto.flush();
  }

  /* ------------------------- navegación entre días ------------------------- */

  protected async goTo(date: string): Promise<void> {
    const my = ++this.seq;
    await this.auto.flush();
    this.date.set(date);
    if (this.reopened() !== date) this.reopened.set('');
    this.loading.set(true);
    this.loadError.set('');
    try {
      const d = await this.data.getDay(date);
      if (my !== this.seq) return;
      this.day = d;
      this.auto.reset(d);
      this.alerts.baseline(d);
      this.markSeen(d);
      const firstPending = d.meals.find((m) => !this.isIdleOptional(m) && (m.before.value === null || m.before.units === null));
      this.openIds.set(new Set(firstPending ? [firstPending.injectionId] : []));
      this.ensureMonth(date.slice(0, 7));
      this.watchRemote(date);
    } catch (e) {
      if (my !== this.seq) return;
      this.day = null;
      this.loadError.set('No se ha podido cargar este día. ' + (e instanceof Error ? e.message : ''));
    } finally {
      if (my === this.seq) this.loading.set(false);
    }
  }

  /**
   * Cambios que hacen otros cuidadores sobre este mismo día: se reflejan al instante.
   * Si tienes cambios sin guardar, no se pisan (se guardan en menos de un segundo).
   */
  private watchRemote(date: string): void {
    this.unwatch?.();
    this.unwatch = this.data.watchDay(date, (remote) => {
      if (this.date() !== date || !this.day || this.auto.dirty) return;
      if (canon(remote) === canon(this.day)) return;
      this.day = remote;
      this.auto.reset(remote);
      this.alerts.baseline(remote);
      this.markSeen(remote);
    });
  }

  protected shift(n: number): void {
    void this.goTo(addDays(this.date(), n));
  }

  protected onPick(date: string): void {
    this.calendarOpen.set(false);
    void this.goTo(date);
  }

  /** Los días pasados se cierran: solo lectura (salvo que un administrador los reabra). */
  protected locked(): boolean {
    return isClosedDay(this.date()) && this.reopened() !== this.date();
  }

  /** Corregir un día cerrado está reservado a administradores (y al modo local, de un solo usuario). */
  protected canReopen(): boolean {
    return this.auth.isAdmin() || this.auth.status() === 'local';
  }

  protected reopen(): void {
    if (this.canReopen()) this.reopened.set(this.date());
  }

  protected relock(): void {
    void this.auto.flush();
    this.reopened.set('');
  }

  protected isClosedDay_(): boolean {
    return isClosedDay(this.date());
  }

  protected isToday(): boolean {
    return this.date() === todayStr();
  }

  protected dateLabel(): string {
    const t = strToDate(this.date()).toLocaleDateString('es-ES', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  protected ensureMonth(ym: string): void {
    if (this.loadedMonths.has(ym)) return;
    this.loadedMonths.add(ym);
    this.data
      .getMonth(ym)
      .then((days) => {
        const add: Record<string, DayMark> = {};
        for (const d of days) add[d.date] = dayMark(d);
        this.marks.update((m) => ({ ...add, ...m }));
      })
      .catch(() => this.loadedMonths.delete(ym));
  }

  private setMark(d: DayRecord): void {
    this.marks.update((m) => ({ ...m, [d.date]: dayMark(d) }));
  }

  /* ------------------------- administraciones ------------------------- */

  protected isOpen(m: Meal): boolean {
    return this.openIds().has(m.injectionId);
  }

  protected toggleOpen(m: Meal): void {
    this.openIds.update((s) => {
      const n = new Set(s);
      if (n.has(m.injectionId)) n.delete(m.injectionId);
      else n.add(m.injectionId);
      return n;
    });
  }

  /** Comida opcional (p. ej. media mañana) que no se ha usado: no cuenta como pendiente. */
  protected isIdleOptional(m: Meal): boolean {
    return (
      !!m.optional &&
      !m.before.time &&
      m.before.value === null &&
      !m.before.arrow &&
      m.before.units === null &&
      !m.foodTime &&
      m.items.length === 0 &&
      m.after.value === null
    );
  }

  /** Las 4 lecturas obligatorias: hora, glucemia, flecha y unidades. */
  protected missing(m: Meal): string[] {
    const out: string[] = [];
    if (this.isIdleOptional(m)) return out;
    if (!m.before.time) out.push('hora');
    if (m.before.value === null) out.push('glucemia');
    if (!m.before.arrow) out.push('flecha');
    if (m.before.units === null) out.push('unidades');
    return out;
  }

  private markSeen(d: DayRecord): void {
    this.valueSeen.clear();
    for (const m of d.meals) if (m.before.value !== null) this.valueSeen.add(d.date + '|' + m.injectionId);
  }

  /**
   * Al anotar por primera vez la glucemia de una administración, se propone la dosis por defecto
   * configurada en Ajustes (si hay). Se puede cambiar o quitar con el desplegable.
   */
  private applyDefaultUnits(): void {
    const d = this.day;
    if (!d) return;
    for (const m of d.meals) {
      if (m.before.value === null) continue;
      const key = d.date + '|' + m.injectionId;
      if (this.valueSeen.has(key)) continue;
      this.valueSeen.add(key);
      if (m.before.units !== null) continue;
      const def = this.data.settings().injections.find((i) => i.id === m.injectionId)?.defaultUnits;
      if (def != null && def > 0) m.before.units = def;
    }
  }

  protected defaultUnits(m: Meal): number | null {
    return this.data.settings().injections.find((i) => i.id === m.injectionId)?.defaultUnits ?? null;
  }

  /** Opciones del desplegable de unidades (enteras y medias), según la configuración. */
  protected unitOptions(m: Meal): number[] {
    const inj = this.data.settings().injections.find((i) => i.id === m.injectionId);
    const max = inj?.maxUnits ?? 20;
    const step = this.data.settings().doseStep || 0.5;
    const cur = m.before.units;
    const key = `${max}|${step}|${cur}`;
    let opts = this.unitCache.get(key);
    if (!opts) {
      opts = [];
      for (let i = 0; i <= Math.round(max / step); i++) opts.push(round(i * step, 2));
      if (cur !== null && !opts.includes(cur)) opts = [...opts, cur].sort((a, b) => a - b);
      this.unitCache.set(key, opts);
    }
    return opts;
  }

  /* ------------------------- comida ------------------------- */

  protected setNow(m: Meal): void {
    m.foodTime = nowTime();
  }

  protected addItem(m: Meal): void {
    m.items.push({ id: uid(), name: '', quantity: '', rations: null });
  }

  /** Texto corto de una cantidad de raciones (cabe en el móvil): «0 rac.», «½ rac.», «1 rac.», «1½ rac.»… */
  protected rationLabel(n: number): string {
    const whole = Math.floor(n);
    const half = n - whole === 0.5;
    if (!half && n !== whole) return `${fmtNum(n, 2)} rac.`;
    return `${half ? (whole ? `${whole}½` : '½') : whole} rac.`;
  }

  private readonly rationBase = Array.from({ length: 25 }, (_, i) => i * 0.5); // 0 … 12 raciones

  /** Opciones del selector de raciones (de media en media). Si el alimento trae otro valor, también se ofrece. */
  protected rationOptions(it: FoodEntry): number[] {
    const cur = it.rations;
    if (typeof cur === 'number' && !this.rationBase.includes(cur)) return [...this.rationBase, cur].sort((a, b) => a - b);
    return this.rationBase;
  }

  /** Raciones previstas para esta comida (Ajustes), o null si no se ha configurado nada. */
  protected plan(m: Meal): (RationPlan & { total: number }) | null {
    const p = this.data.settings().injections.find((i) => i.id === m.injectionId)?.plan;
    const total = planTotal(p);
    return p && total > 0 ? { ...p, total } : null;
  }

  /** Gramos de un alimento del catálogo que equivalen a una ración (null si no tiene hidratos). */
  protected foodRationGrams(f: { carbsPer100g: number }): number | null {
    return f.carbsPer100g > 0 ? (this.gramsPerRation() * 100) / f.carbsPer100g : null;
  }

  /** Equivalencia en gramos del alimento escrito (si está en el catálogo): «1 ración de Pasta cocida = 40 g · 2 rac. ≈ 80 g». */
  protected foodHint(it: FoodEntry): string | null {
    const f = findFood(it.name ?? '', this.data.foods());
    if (!f) return null;
    const g = this.foodRationGrams(f);
    if (g === null) return `${f.name}: sin hidratos`;
    let t = `1 ración de ${f.name} = ${fmtNum(g, 0)} g`;
    if (typeof it.rations === 'number' && it.rations > 0 && it.rations !== 1) t += ` · ${this.rationLabel(it.rations)} ≈ ${fmtNum(it.rations * g, 0)} g`;
    return t;
  }

  protected rationsTotal(m: Meal): number {
    return m.items.reduce((acc, it) => acc + (typeof it.rations === 'number' ? it.rations : 0), 0);
  }

  protected gramsPerRation(): number {
    return this.data.settings().gramsPerRation || 10;
  }

  protected removeItem(m: Meal, it: FoodEntry): void {
    m.items = m.items.filter((x) => x.id !== it.id);
  }

  /* ------------------------- mediciones intermedias ------------------------- */

  /** Las mediciones intermedias se cuelgan de las comidas de rápida (la lenta no tiene). */
  protected canHaveExtras(m: Meal): boolean {
    return m.kind !== 'lenta';
  }

  protected extrasFor(d: DayRecord, m: Meal): ExtraReading[] {
    return d.extras
      .filter((x) => x.afterInjectionId === m.injectionId)
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  }

  protected addExtra(d: DayRecord, m: Meal): void {
    d.extras.push({
      id: uid(),
      afterInjectionId: m.injectionId,
      source: 'monitor',
      time: this.isToday() ? nowTime() : '',
      value: null,
      arrow: null,
      note: '',
      extraRations: null,
    });
  }

  protected removeExtra(d: DayRecord, x: ExtraReading): void {
    if (confirm('¿Eliminar esta medición?')) d.extras = d.extras.filter((e) => e.id !== x.id);
  }

  /* ------------------------- actividad física ------------------------- */

  protected addActivity(d: DayRecord): void {
    const a: Activity = {
      id: uid(),
      start: this.isToday() ? nowTime() : '',
      end: '',
      type: '',
      before: emptyReading(),
      after: emptyReading(),
      supplemented: false,
      supplementDetail: '',
      incident: '',
    };
    d.activities.push(a);
  }

  protected removeActivity(d: DayRecord, a: Activity): void {
    if (confirm('¿Eliminar esta actividad?')) d.activities = d.activities.filter((x) => x.id !== a.id);
  }

  protected setActivityNow(a: Activity, field: 'start' | 'end'): void {
    a[field] = nowTime();
  }
}
