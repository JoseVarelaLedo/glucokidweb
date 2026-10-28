import type { Firestore } from 'firebase/firestore';
import { getDb } from './firebase-app';
import { AlertItem, DayRecord, DocItem, Food, Settings } from './models';

export type WriteResult = 'saved' | 'queued';

export interface Store {
  init(): Promise<void>;
  /** Propietario de los datos con los que se trabaja (cada usuario tiene los suyos). */
  setUser(uid: string): void;
  loadSettings(): Promise<Settings | null>;
  saveSettings(s: Settings): Promise<WriteResult>;
  loadFoods(): Promise<Food[] | null>;
  saveFoods(f: Food[]): Promise<WriteResult>;
  loadDay(date: string): Promise<DayRecord | null>;
  saveDay(d: DayRecord): Promise<WriteResult>;
  loadRange(from: string, to: string): Promise<DayRecord[]>;
  /** Cambios en directo de un día (cuando otro cuidador lo edita). Devuelve la función para dejar de escuchar. */
  watchDay(date: string, cb: (d: DayRecord) => void): () => void;
  loadDocs(): Promise<DocItem[]>;
  loadDoc(slug: string): Promise<DocItem | null>;
  saveDoc(d: DocItem): Promise<WriteResult>;
  deleteDoc(slug: string): Promise<void>;
  pushAlert(a: AlertItem): Promise<void>;
  /** Avisos nuevos desde `sinceMs`. */
  watchAlerts(sinceMs: number, cb: (a: AlertItem[]) => void): () => void;
}

/* ------------------------------------------------------------------ */
/* Modo local: localStorage del navegador                              */
/* ------------------------------------------------------------------ */

const P = 'glucokid:';

export class LocalStore implements Store {
  async init(): Promise<void> {}
  setUser(): void {}

  private read<T>(key: string): T | null {
    try {
      const v = localStorage.getItem(P + key);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): void {
    localStorage.setItem(P + key, JSON.stringify(value));
  }

  async loadSettings(): Promise<Settings | null> {
    return this.read<Settings>('settings');
  }
  async saveSettings(s: Settings): Promise<WriteResult> {
    this.write('settings', s);
    return 'saved';
  }
  async loadFoods(): Promise<Food[] | null> {
    return this.read<Food[]>('foods');
  }
  async saveFoods(f: Food[]): Promise<WriteResult> {
    this.write('foods', f);
    return 'saved';
  }
  async loadDay(date: string): Promise<DayRecord | null> {
    return this.read<DayRecord>('day:' + date);
  }
  async saveDay(d: DayRecord): Promise<WriteResult> {
    this.write('day:' + d.date, d);
    return 'saved';
  }
  async loadRange(from: string, to: string): Promise<DayRecord[]> {
    const out: DayRecord[] = [];
    const prefix = P + 'day:';
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const date = k.slice(prefix.length);
      if (date >= from && date <= to) {
        const d = this.read<DayRecord>('day:' + date);
        if (d) out.push(d);
      }
    }
    return out;
  }

  watchDay(): () => void {
    return () => undefined;
  }
  async loadDocs(): Promise<DocItem[]> {
    return this.read<DocItem[]>('docs') ?? [];
  }
  async loadDoc(slug: string): Promise<DocItem | null> {
    return (await this.loadDocs()).find((d) => d.slug === slug) ?? null;
  }
  async saveDoc(d: DocItem): Promise<WriteResult> {
    const all = (await this.loadDocs()).filter((x) => x.slug !== d.slug);
    all.push(d);
    this.write('docs', all);
    return 'saved';
  }
  async deleteDoc(slug: string): Promise<void> {
    this.write('docs', (await this.loadDocs()).filter((x) => x.slug !== slug));
  }
  async pushAlert(): Promise<void> {}
  watchAlerts(): () => void {
    return () => undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Modo nube: Cloud Firestore con caché offline. Todo cuelga del usuario: */
/*   users/{uid}                       → perfil (rol, nombre, activo)     */
/*   users/{uid}/days/{YYYY-MM-DD}     → un documento por día             */
/*   users/{uid}/config/settings       → pauta y ratio                    */
/*   users/{uid}/config/foods          → catálogo { items: [...] }        */
/*   users/{uid}/docs/{slug}           → documentación en Markdown        */
/*   users/{uid}/alerts/{id}           → avisos entre cuidadores          */
/* ------------------------------------------------------------------ */

export class FirestoreStore implements Store {
  private fs!: typeof import('firebase/firestore');
  private db!: Firestore;
  private uid = '';

  async init(): Promise<void> {
    this.db = await getDb();
    this.fs = await import('firebase/firestore');
  }

  setUser(uid: string): void {
    this.uid = uid;
  }

  private ref(...path: string[]) {
    if (!this.uid) throw new Error('Sin usuario seleccionado');
    return this.fs.doc(this.db, 'users', this.uid, ...(path as [string, ...string[]]));
  }

  /**
   * Con la caché offline, setDoc no se resuelve hasta que el servidor confirma.
   * Si tarda más de 4 s damos el cambio por "en cola": ya está en el dispositivo
   * y se sincroniza solo al volver la conexión.
   */
  private async commit(p: Promise<void>): Promise<WriteResult> {
    return Promise.race([
      p.then((): WriteResult => 'saved'),
      new Promise<WriteResult>((resolve) => setTimeout(() => resolve('queued'), 4000)),
    ]);
  }

  async loadSettings(): Promise<Settings | null> {
    const snap = await this.fs.getDoc(this.ref('config', 'settings'));
    return snap.exists() ? (snap.data() as Settings) : null;
  }
  async saveSettings(s: Settings): Promise<WriteResult> {
    return this.commit(this.fs.setDoc(this.ref('config', 'settings'), s));
  }

  async loadFoods(): Promise<Food[] | null> {
    const snap = await this.fs.getDoc(this.ref('config', 'foods'));
    return snap.exists() ? ((snap.data() as { items: Food[] }).items ?? null) : null;
  }
  async saveFoods(items: Food[]): Promise<WriteResult> {
    return this.commit(this.fs.setDoc(this.ref('config', 'foods'), { items }));
  }

  async loadDay(date: string): Promise<DayRecord | null> {
    const snap = await this.fs.getDoc(this.ref('days', date));
    return snap.exists() ? (snap.data() as DayRecord) : null;
  }
  async saveDay(d: DayRecord): Promise<WriteResult> {
    return this.commit(this.fs.setDoc(this.ref('days', d.date), { ...d, updatedAt: Date.now() }));
  }

  async loadRange(from: string, to: string): Promise<DayRecord[]> {
    const { collection, query, where, documentId, getDocs } = this.fs;
    const q = query(
      collection(this.db, 'users', this.uid, 'days'),
      where(documentId(), '>=', from),
      where(documentId(), '<=', to),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as DayRecord);
  }

  watchDay(date: string, cb: (d: DayRecord) => void): () => void {
    return this.fs.onSnapshot(this.ref('days', date), (snap) => {
      // Ignoramos el "eco" de nuestras propias escrituras pendientes
      if (snap.metadata.hasPendingWrites || !snap.exists()) return;
      cb(snap.data() as DayRecord);
    });
  }

  async loadDocs(): Promise<DocItem[]> {
    const snap = await this.fs.getDocs(this.fs.collection(this.db, 'users', this.uid, 'docs'));
    return snap.docs.map((d) => d.data() as DocItem).sort((a, b) => a.title.localeCompare(b.title, 'es'));
  }
  async loadDoc(slug: string): Promise<DocItem | null> {
    const snap = await this.fs.getDoc(this.ref('docs', slug));
    return snap.exists() ? (snap.data() as DocItem) : null;
  }
  async saveDoc(d: DocItem): Promise<WriteResult> {
    return this.commit(this.fs.setDoc(this.ref('docs', d.slug), d));
  }
  async deleteDoc(slug: string): Promise<void> {
    await this.fs.deleteDoc(this.ref('docs', slug));
  }

  async pushAlert(a: AlertItem): Promise<void> {
    // id determinista: si dos dispositivos detectan la misma lectura, solo queda un aviso
    await this.fs.setDoc(this.ref('alerts', a.id), a);
  }
  watchAlerts(sinceMs: number, cb: (a: AlertItem[]) => void): () => void {
    const { collection, query, where, onSnapshot } = this.fs;
    const q = query(collection(this.db, 'users', this.uid, 'alerts'), where('at', '>=', sinceMs));
    return onSnapshot(q, (snap) => {
      const added = snap.docChanges().filter((c) => c.type === 'added').map((c) => c.doc.data() as AlertItem);
      if (added.length) cb(added);
    });
  }
}
