import { Injectable, computed, signal } from '@angular/core';
import type { Auth } from 'firebase/auth';
import { getDb, getFirebaseApp, wipeLocalCache } from './firebase-app';
import { firebaseEnabled } from './firebase.config';
import { InviteItem, UserProfile } from './models';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'noAccess' | 'local';

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly status = signal<AuthStatus>('loading');
  readonly email = signal('');
  readonly profile = signal<UserProfile | null>(null);
  readonly error = signal('');
  readonly busy = signal(false);

  readonly isAdmin = computed(() => this.profile()?.role === 'admin');
  /** Propietario de los datos propios ('local' en modo sin Firebase). */
  readonly uid = computed(() => this.profile()?.uid ?? 'local');
  /** Espacio de datos de esta cuenta: el suyo, o el del niño con el que comparte. */
  readonly dataUid = computed(() => this.profile()?.dataUid || this.profile()?.uid || 'local');
  readonly name = computed(() => this.profile()?.name || this.email() || 'Alguien');

  /** Tareas a hacer antes de cerrar sesión (p. ej. retirar este dispositivo de los avisos push). */
  readonly beforeLogout: Array<() => Promise<void>> = [];

  /** Mientras se completa un alta por invitación, onUser no debe decidir 'sin acceso' (el perfil aún no existe). */
  private registering = false;

  private mod!: typeof import('firebase/auth');
  private auth!: Auth;

  async init(): Promise<void> {
    if (!firebaseEnabled) {
      this.status.set('local');
      return;
    }
    const app = await getFirebaseApp();
    this.mod = await import('firebase/auth');
    this.auth = this.mod.getAuth(app);
    this.mod.onAuthStateChanged(this.auth, (user) => void this.onUser(user?.uid ?? null, user?.email ?? ''));
  }

  private async onUser(uid: string | null, email: string): Promise<void> {
    if (!uid) {
      this.profile.set(null);
      this.email.set('');
      this.status.set('signedOut');
      return;
    }
    if (this.registering) return;
    this.email.set(email);
    this.status.set('loading');
    try {
      const db = await getDb();
      const fs = await import('firebase/firestore');
      const snap = await fs.getDoc(fs.doc(db, 'users', uid));
      const d = snap.exists() ? snap.data() : null;
      if (!d || d['active'] === false) {
        this.profile.set(null);
        this.status.set('noAccess');
        return;
      }
      this.profile.set({
        uid,
        email,
        name: (d['name'] as string) || email,
        role: d['role'] === 'admin' ? 'admin' : 'user',
        active: true,
        dataUid: (d['dataUid'] as string) || '',
      });
      this.status.set('signedIn');
    } catch {
      this.profile.set(null);
      this.status.set('noAccess');
    }
  }

  async login(email: string, password: string): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    try {
      await this.mod.signInWithEmailAndPassword(this.auth, email.trim(), password);
    } catch (e) {
      this.error.set(this.explain((e as { code?: string }).code ?? ''));
    } finally {
      this.busy.set(false);
    }
  }

  /** Token de sesión actual (para llamar a la función de avisos push). */
  async idToken(): Promise<string> {
    try {
      return (await this.auth?.currentUser?.getIdToken()) ?? '';
    } catch {
      return '';
    }
  }

  async logout(): Promise<void> {
    for (const f of this.beforeLogout) await f().catch(() => undefined);
    await this.mod.signOut(this.auth);
    await wipeLocalCache();
    location.reload();
  }

  async sendReset(email: string): Promise<void> {
    await this.mod.sendPasswordResetEmail(this.auth, email);
  }

  /**
   * Crea una cuenta nueva SIN cerrar la sesión del administrador:
   * se usa una segunda instancia de Firebase solo para ese alta.
   */
  async createAccount(email: string, password: string): Promise<string> {
    const { initializeApp, deleteApp } = await import('firebase/app');
    const { firebaseConfig } = await import('./firebase.config');
    const second = initializeApp(firebaseConfig, 'alta-' + Date.now());
    try {
      const auth2 = this.mod.getAuth(second);
      const cred = await this.mod.createUserWithEmailAndPassword(auth2, email.trim(), password);
      const uid = cred.user.uid;
      await this.mod.signOut(auth2);
      return uid;
    } finally {
      await deleteApp(second);
    }
  }

  /**
   * Alta por invitación: crea la cuenta, y en UNA sola operación guarda su perfil (usuario normal, con los datos
   * del niño de la invitación) y consume la invitación. Si algo falla, la cuenta recién creada se elimina.
   */
  async registerWithInvite(inv: InviteItem, name: string, email: string, password: string): Promise<void> {
    this.registering = true;
    let created: import('firebase/auth').User | null = null;
    try {
      const cred = await this.mod.createUserWithEmailAndPassword(this.auth, email.trim(), password);
      created = cred.user;
      const db = await getDb();
      const fs = await import('firebase/firestore');
      const mail = cred.user.email ?? email.trim().toLowerCase();
      const batch = fs.writeBatch(db);
      batch.set(fs.doc(db, 'users', cred.user.uid), {
        email: mail,
        name: name.trim().slice(0, 80) || mail,
        role: 'user',
        active: true,
        dataUid: inv.dataUid,
        invite: inv.code,
      });
      batch.delete(fs.doc(db, 'invites', inv.code));
      await batch.commit();
    } catch (e) {
      if (created) await this.mod.deleteUser(created).catch(() => undefined);
      this.registering = false;
      throw e;
    }
    this.registering = false;
    await this.onUser(created.uid, created.email ?? email.trim());
  }

  explainCode(e: unknown): string {
    return this.explain((e as { code?: string }).code ?? '');
  }

  private explain(code: string): string {
    switch (code) {
      case 'auth/invalid-credential':
      case 'auth/wrong-password':
      case 'auth/user-not-found':
        return 'Correo o contraseña incorrectos.';
      case 'auth/invalid-email':
        return 'El correo no tiene un formato válido.';
      case 'auth/email-already-in-use':
        return 'Ya existe una cuenta con ese correo.';
      case 'auth/weak-password':
        return 'La contraseña es demasiado débil (mínimo 6 caracteres).';
      case 'auth/too-many-requests':
        return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
      case 'auth/network-request-failed':
        return 'Sin conexión. Comprueba tu red.';
      case 'permission-denied':
        return 'No tienes permiso para esta operación.';
      default:
        return 'No se ha podido completar la operación.';
    }
  }
}
