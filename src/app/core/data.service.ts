import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { makeDefaultFoods, makeDefaultSettings, migrateSettings, newDay, normalizeExtras, syncDay } from './defaults';
import { firebaseEnabled } from './firebase.config';
import { DayRecord, DocItem, Food, FoodEntry, Settings } from './models';
import { FirestoreStore, LocalStore, Store, WriteResult } from './stores';
import { fmtNum, todayStr, uid } from './util';

export type SaveState = 'idle' | 'saving' | 'saved' | 'queued' | 'error';

@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly auth = inject(AuthService);
  /** usuario cuyos datos se muestran (el propio, o cualquiera si eres administrador). */
  readonly viewUid = signal('');
  readonly viewingOther = computed(() => this.auth.isAdmin() && this.viewUid() !== '' && this.viewUid() !== this.auth.dataUid());
  readonly settings = signal<Settings>(makeDefaultSettings());
  readonly foods = signal<Food[]>(makeDefaultFoods());
  readonly ready = signal(false);
  readonly initError = signal('');
  readonly saveState = signal<SaveState>('idle');

  private store!: Store;
  private initializing?: Promise<void>;

  init(): Promise<void> {
    this.initializing ??= this.doInit();
    return this.initializing;
  }

  /** sólo administradores: cambia a los datos de otro usuario (la seguridad real la imponen las reglas de Firestore). */
  switchUser(uid: string): Promise<void> {
    if (!this.auth.isAdmin()) return Promise.resolve();
    this.ready.set(false);
    this.viewUid.set(uid);
    this.initializing = undefined;
    return this.init();
  }

  retry(): Promise<void> {
    this.initializing = undefined;
    return this.init();
  }

  private async doInit(): Promise<void> {
    this.initError.set('');
    try {
      this.store = firebaseEnabled ? new FirestoreStore() : new LocalStore();
      await this.store.init();
      if (!this.viewUid()) this.viewUid.set(this.auth.dataUid());
      this.store.setUser(this.viewUid());

      const [settings, foods] = await Promise.all([this.store.loadSettings(), this.store.loadFoods()]);
      const cfg = settings ?? makeDefaultSettings();
      const migrated = settings ? migrateSettings(cfg) : false;
      this.settings.set(cfg);
      this.foods.set(foods ?? makeDefaultFoods());
      // primera vez (o ajustes antiguos migrados): dejamos escritos los valores para que todos los dispositivos compartan los mismos.
      if (!settings || migrated) void this.saveSettings(this.settings());
      if (!foods) void this.saveFoods(this.foods());
      this.ready.set(true);
    } catch (e) {
      this.initializing = undefined;
      this.initError.set(
        'No se han podido cargar los datos. Comprueba la conexión y vuelve a intentarlo. ' +
          (e instanceof Error ? `(${e.message})` : ''),
      );
    }
  }

  /* ---------------- días ---------------- */

  async getDay(date: string): Promise<DayRecord> {
    const stored = await this.store.loadDay(date);
    const day = stored ?? newDay(date, this.settings());
    // defensa ante documentos antiguos o incompletos
    day.meals ??= [];
    day.extras ??= [];
    day.activities ??= [];
    normalizeExtras(day);
    return syncDay(day, this.settings(), todayStr());
  }

  /** rango de días ya guardados (sin crear los vacíos). */
  getRange(from: string, to: string): Promise<DayRecord[]> {
    return this.store.loadRange(from, to);
  }

  /** cambios en directo del día que edita otro cuidador. */
  watchDay(date: string, cb: (d: DayRecord) => void): () => void {
    return this.store.watchDay(date, (d) => {
      delete (d as unknown as Record<string, unknown>)['updatedAt'];
      d.meals ??= [];
      d.extras ??= [];
      d.activities ??= [];
      normalizeExtras(d);
      cb(syncDay(d, this.settings(), todayStr()));
    });
  }

  /* ---------------- documentación ---------------- */

  loadDocs(): Promise<DocItem[]> {
    return this.store.loadDocs();
  }
  loadDoc(slug: string): Promise<DocItem | null> {
    return this.store.loadDoc(slug);
  }
  saveDoc(d: DocItem): Promise<unknown> {
    return this.track(this.store.saveDoc(d));
  }
  deleteDoc(slug: string): Promise<void> {
    return this.store.deleteDoc(slug);
  }

  /* ---------------- avisos ---------------- */

  pushAlert(a: import('./models').AlertItem): Promise<void> {
    return this.store.pushAlert(a);
  }
  watchAlerts(sinceMs: number, cb: (a: import('./models').AlertItem[]) => void): () => void {
    return this.store.watchAlerts(sinceMs, cb);
  }

  /** Copia de seguridad completa del espacio de datos actual (todo lo que ve esta cuenta). */
  async exportAll(): Promise<Blob> {
    const [days, docs] = await Promise.all([this.store.loadRange('0000-01-01', '9999-12-31'), this.store.loadDocs()]);
    const payload = {
      app: 'glucokid',
      exportedAt: new Date().toISOString(),
      dataUid: this.viewUid(),
      settings: this.settings(),
      foods: this.foods(),
      days: days.sort((a, b) => a.date.localeCompare(b.date)),
      docs,
    };
    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  }

  saveDay(d: DayRecord): Promise<WriteResult> {
    return this.track(this.store.saveDay(d));
  }

  getMonth(ym: string): Promise<DayRecord[]> {
    return this.store.loadRange(`${ym}-01`, `${ym}-31`);
  }

  /** Pasa el resultado de la calculadora al registro de un día: unidades y alimentos. */
  async applyCalculation(
    date: string,
    injectionId: string,
    units: number,
    items: Array<{ name: string; quantity: string }>,
  ): Promise<boolean> {
    const day = await this.getDay(date);
    const meal = day.meals.find((m) => m.injectionId === injectionId);
    if (!meal) return false;
    meal.before.units = units;
    const entries: FoodEntry[] = items.map((i) => ({ id: uid(), name: i.name, quantity: i.quantity }));
    meal.items.push(...entries);
    await this.saveDay(day);
    return true;
  }

  /* ---------------- configuración y alimentos ---------------- */

  saveSettings(s: Settings): Promise<WriteResult> {
    return this.track(this.store.saveSettings(s));
  }

  saveFoods(f: Food[]): Promise<WriteResult> {
    return this.track(this.store.saveFoods(f));
  }

  /* ---------------- estado de guardado ---------------- */

  private async track(p: Promise<WriteResult>): Promise<WriteResult> {
    this.saveState.set('saving');
    try {
      const r = await p;
      this.saveState.set(r);
      return r;
    } catch (e) {
      this.saveState.set('error');
      throw e;
    }
  }

  saveLabel(): string {
    switch (this.saveState()) {
      case 'saving':
        return 'Guardando…';
      case 'saved':
        return 'Guardado';
      case 'queued':
        return 'Guardado en el dispositivo (se sincronizará)';
      case 'error':
        return 'Error al guardar';
      default:
        return '';
    }
  }

  /** Utilidad de formato compartida por varias pantallas. */
  fmt(n: number | null | undefined, max = 2): string {
    return fmtNum(n, max);
  }
}
