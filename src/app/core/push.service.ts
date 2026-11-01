import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { getDb, getFirebaseApp } from './firebase-app';
import { firebaseEnabled } from './firebase.config';
import { AlertItem } from './models';
import { pushEndpoint, vapidKey } from './push.config';

const KEY_ON = 'glucokid:push-on';

export type PushState = 'unavailable' | 'needs-install' | 'blocked' | 'off' | 'on' | 'busy';

/**
 * Avisos push (Firebase Cloud Messaging) para recibir las alertas con la app cerrada.
 * Cada dispositivo guarda su "token" en users/{espacio}/devices; al registrarse una hipo/hiper,
 * la función de Netlify (netlify/functions/notify.mjs) lo envía a los dispositivos de los demás cuidadores.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly auth = inject(AuthService);

  readonly state = signal<PushState>(this.initial());
  readonly error = signal('');
  readonly available = computed(() => this.state() !== 'unavailable');

  constructor() {
    // Al cerrar sesión se retira este dispositivo (en móviles compartidos no deben seguir llegando avisos).
    this.auth.beforeLogout.push(() => this.forget());
  }

  private initial(): PushState {
    if (!firebaseEnabled || !vapidKey) return 'unavailable';
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return 'unavailable';
    if (!('PushManager' in window)) return this.isIos() && !this.standalone() ? 'needs-install' : 'unavailable';
    if (Notification.permission === 'denied') return 'blocked';
    return this.read(KEY_ON) === '1' && Notification.permission === 'granted' ? 'on' : 'off';
  }

  private isIos(): boolean {
    return /iphone|ipad|ipod/i.test(navigator.userAgent);
  }
  private standalone(): boolean {
    return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  }

  /** Activa los avisos con la app cerrada en este dispositivo. */
  async enable(): Promise<void> {
    if (this.state() === 'busy') return;
    this.error.set('');
    this.state.set('busy');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        this.state.set(perm === 'denied' ? 'blocked' : 'off');
        return;
      }
      await this.register();
      this.write(KEY_ON, '1');
      this.state.set('on');
    } catch (e) {
      this.error.set(this.explain(e));
      this.state.set('off');
    }
  }

  async disable(): Promise<void> {
    this.state.set('busy');
    await this.forget();
    this.state.set(Notification.permission === 'denied' ? 'blocked' : 'off');
  }

  /** Renueva el token si cambió (los navegadores lo rotan de vez en cuando). Se llama al arrancar con sesión. */
  async refresh(): Promise<void> {
    if (this.state() !== 'on' || Notification.permission !== 'granted') return;
    try {
      await this.register();
    } catch {
      /* sin conexión: se reintentará la próxima vez */
    }
  }

  /** Retira este dispositivo: borra su token y su registro. */
  async forget(): Promise<void> {
    if (!firebaseEnabled || !vapidKey || this.read(KEY_ON) !== '1') return;
    this.write(KEY_ON, '0');
    try {
      const { messaging, token } = await this.getToken();
      if (token) {
        const db = await getDb();
        const fs = await import('firebase/firestore');
        const id = await this.hash(token);
        await Promise.all(this.auth.children().map((k) => fs.deleteDoc(fs.doc(db, 'users', k, 'devices', id)).catch(() => undefined)));
      }
      const m = await import('firebase/messaging');
      await m.deleteToken(messaging).catch(() => undefined);
    } catch {
      /* mejor esfuerzo */
    }
  }

  /** Pide a la función de Netlify que avise a los demás cuidadores. Silencioso si no está configurada. */
  async notifyOthers(space: string, a: AlertItem): Promise<void> {
    if (!firebaseEnabled || !vapidKey) return;
    try {
      const token = await this.auth.idToken();
      if (!token) return;
      await fetch(pushEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ space, alert: { id: a.id, kind: a.kind, value: a.value, time: a.time, date: a.date } }),
        keepalive: true,
      });
    } catch {
      /* los avisos con la app abierta siguen funcionando */
    }
  }

  /* ------------------------- interno ------------------------- */

  private async getToken() {
    const app = await getFirebaseApp();
    const m = await import('firebase/messaging');
    if (!(await m.isSupported())) throw new Error('unsupported');
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    const messaging = m.getMessaging(app);
    const token = await m.getToken(messaging, { vapidKey, serviceWorkerRegistration: reg });
    return { messaging, token };
  }

  private async register(): Promise<void> {
    const { token } = await this.getToken();
    if (!token) throw new Error('no-token');
    const db = await getDb();
    const fs = await import('firebase/firestore');
    const id = await this.hash(token);
    const doc = { token, uid: this.auth.uid(), name: this.auth.name(), platform: navigator.userAgent.slice(0, 120), updatedAt: Date.now() };
    // El dispositivo recibe los avisos de TODOS los niños de la cuenta (un abuelo con varios nietos los recibe de todos)
    await Promise.all(this.auth.children().map((k) => fs.setDoc(fs.doc(db, 'users', k, 'devices', id), doc)));
  }

  private async hash(s: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
  }

  private explain(e: unknown): string {
    const code = (e as { code?: string; message?: string }).code ?? '';
    if ((e as Error)?.message === 'unsupported') return 'Este navegador no admite avisos push.';
    if (code.includes('permission-blocked')) return 'Las notificaciones están bloqueadas en este navegador.';
    if (code === 'permission-denied') return 'No tienes permiso para registrar este dispositivo.';
    return 'No se ha podido activar. Comprueba la conexión y vuelve a intentarlo.';
  }

  private read(k: string): string {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
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
