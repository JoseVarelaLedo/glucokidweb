import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { DataService } from './data.service';
import { classify } from './glucose';
import { AlertItem, DayRecord, Reading } from './models';
import { toMin } from './predict';
import { PushService } from './push.service';
import { nowTime, todayStr } from './util';

const KEY_DISMISSED = 'glucokid:alerts-dismissed';
const KEY_SOUND = 'glucokid:alerts-sound';
// avisos de las últimas 6 h
const RECENT_MS = 6 * 3600 * 1000;
// sólo se avisa de lecturas de las últimas 3 h
const FRESH_READING_MIN = 180;

/**
 * Avisos entre personas que comparten un niño. Cuando alguien guarda una lectura de hipoglucemia
 * (< 70) o de hiperglucemia (> 350), se escribe un aviso en Firestore; los demás dispositivos con
 * la app abierta lo reciben al instante (banner, sonido, vibración y notificación del navegador).
 *
 * con la app cerrada, el aviso llega por notificación push (PushService + función de Netlify, ver PUSH.md) si está configurada.
 */
@Injectable({ providedIn: 'root' })
export class AlertsService {
  private readonly data = inject(DataService);
  private readonly auth = inject(AuthService);
  private readonly push = inject(PushService);

  readonly list = signal<AlertItem[]>([]);
  readonly sound = signal<boolean>(this.read(KEY_SOUND, '1') === '1');
  readonly permission = signal<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );

  private unwatch?: () => void;
  private startedAt = 0;
  private readonly seen = new Set<string>();
  // día --> lecturas fuera de rango ya conocidas
  private readonly known = new Map<string, Set<string>>();
  private audio?: AudioContext;

  /** empieza a escuchar los avisos del niño actual (se llama cuando los datos están listos). */
  start(): void {
    this.stop();
    this.startedAt = Date.now();
    this.unwatch = this.data.watchAlerts(Date.now() - RECENT_MS, (items) => this.onAlerts(items));
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.list.set([]);
    this.seen.clear();
    this.known.clear();
  }

  /* ------------------------- recepción ------------------------- */

  private onAlerts(items: AlertItem[]): void {
    const dismissed = this.dismissedIds();
    const mine = this.auth.uid();
    const fresh: AlertItem[] = [];
    for (const a of items) {
      if (a.byUid === mine || this.seen.has(a.id) || dismissed.has(a.id)) continue;
      this.seen.add(a.id);
      fresh.push(a);
    }
    if (!fresh.length) return;
    this.list.update((l) => [...fresh, ...l].sort((x, y) => y.at - x.at));
    // sólo suena/vibra para avisos creados DESPUÉS de abrir la app; los anteriores solo aparecen en el banner
    const live = fresh.filter((a) => a.at >= this.startedAt - 5000);
    if (live.length) void this.notify(live[0], live.length);
  }

  dismiss(id: string): void {
    this.list.update((l) => l.filter((a) => a.id !== id));
    const d = this.dismissedIds();
    d.add(id);
    this.write(KEY_DISMISSED, JSON.stringify([...d].slice(-200)));
  }

  dismissAll(): void {
    for (const a of [...this.list()]) this.dismiss(a.id);
  }

  text(a: AlertItem): string {
    const what = a.kind === 'hipo' ? 'hipoglucemia' : 'hiperglucemia';
    return `${a.byName} ha registrado ${a.value} mg/dL (${what}) a las ${a.time}.`;
  }

  /* ------------------------- aviso local ------------------------- */

  private async notify(a: AlertItem, count: number): Promise<void> {
    const body = count > 1 ? `${count} avisos nuevos. ${this.text(a)}` : this.text(a);
    try {
      navigator.vibrate?.([300, 120, 300, 120, 500]);
    } catch {
      /* sin vibración */
    }
    if (this.sound()) this.beep(a.kind === 'hipo');
    if (this.permission() === 'granted') {
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        const title = a.kind === 'hipo' ? '⚠ Hipoglucemia registrada' : '⚠ Hiperglucemia registrada';
        if (reg) await reg.showNotification(title, { body, tag: a.id, requireInteraction: true });
        else new Notification(title, { body, tag: a.id });
      } catch {
        /* algunos navegadores no permiten notificaciones desde la página */
      }
    }
  }

  private beep(urgent: boolean): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      const tones = urgent ? [880, 660, 880, 660] : [660, 880];
      tones.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        o.type = 'sine';
        g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.22);
        g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + i * 0.22 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.22 + 0.2);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.22);
        o.stop(ctx.currentTime + i * 0.22 + 0.21);
      });
    } catch {
      /* el navegador bloquea el audio hasta que haya una interacción */
    }
  }

  setSound(on: boolean): void {
    this.sound.set(on);
    this.write(KEY_SOUND, on ? '1' : '0');
    // vista previa (además desbloquea el audio del navegador)
    if (on) this.beep(false);
  }

  /** pide permiso para notificaciones del navegador y registra el service worker mínimo. */
  async enableNotifications(): Promise<void> {
    if (typeof Notification === 'undefined') {
      this.permission.set('unsupported');
      return;
    }
    try {
      if ('serviceWorker' in navigator) await navigator.serviceWorker.register('sw.js');
    } catch {
      /* sin service worker se usará new Notification() donde esté permitido */
    }
    this.permission.set(await Notification.requestPermission());
  }

  /* ------------------------- emisión ------------------------- */

  private readings(day: DayRecord): Array<{ key: string; r: Reading }> {
    const out: Array<{ key: string; r: Reading }> = [];
    for (const m of day.meals) {
      out.push({ key: `b:${m.injectionId}`, r: m.before }, { key: `a:${m.injectionId}`, r: m.after });
    }
    for (const x of day.extras) out.push({ key: `x:${x.id}`, r: x });
    for (const a of day.activities) {
      out.push({ key: `ab:${a.id}`, r: { ...a.before, time: a.start } }, { key: `aa:${a.id}`, r: { ...a.after, time: a.end } });
    }
    return out;
  }

  private flagged(day: DayRecord): Array<{ id: string; kind: 'hipo' | 'hiper'; r: Reading }> {
    const out: Array<{ id: string; kind: 'hipo' | 'hiper'; r: Reading }> = [];
    for (const { key, r } of this.readings(day)) {
      if (r.value === null || r.value === undefined) continue;
      const c = classify(r.value, r.arrow);
      if (c?.cls === 'hipo' || c?.cls === 'hiper') out.push({ id: `${key}:${r.value}`, kind: c.cls, r });
    }
    return out;
  }

  /** marca como "ya conocidas" las lecturas fuera de rango que ya tiene el día (al cargarlo o recibir cambios de otro). */
  baseline(day: DayRecord): void {
    const set = this.known.get(day.date) ?? new Set<string>();
    for (const f of this.flagged(day)) set.add(f.id);
    this.known.set(day.date, set);
  }

  /** tras guardar: avisa de lecturas NUEVAS en hipo/hiper (sólo de hoy y de las últimas 3 horas). */
  async check(day: DayRecord): Promise<void> {
    const set = this.known.get(day.date) ?? new Set<string>();
    this.known.set(day.date, set);
    const now = toMin(nowTime());
    for (const f of this.flagged(day)) {
      if (set.has(f.id)) continue;
      set.add(f.id);
      const t = toMin(f.r.time);
      if (day.date !== todayStr() || t === null || now === null || now - t > FRESH_READING_MIN || t - now > 15) continue;
      const alert: AlertItem = {
        id: `${day.date}_${f.id}`.replace(/[^A-Za-z0-9_:.-]/g, '-'),
        kind: f.kind,
        value: f.r.value as number,
        arrow: f.r.arrow,
        time: f.r.time,
        date: day.date,
        byUid: this.auth.uid(),
        byName: this.auth.name(),
        at: Date.now(),
      };
      try {
        await this.data.pushAlert(alert);
        // aviso push a los móviles de los demás cuidadores (también con la app cerrada), si está configurado
        void this.push.notifyOthers(this.data.viewUid() || this.auth.dataUid(), alert);
      } catch {
        /* sin conexión: el aviso no se podrá enviar; el registro sí queda guardado */
      }
    }
  }

  /* ------------------------- utilidades ------------------------- */

  private dismissedIds(): Set<string> {
    try {
      return new Set<string>(JSON.parse(this.read(KEY_DISMISSED, '[]')));
    } catch {
      return new Set();
    }
  }
  private read(k: string, d: string): string {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  }
  private write(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* sin almacenamiento */
    }
  }
}
