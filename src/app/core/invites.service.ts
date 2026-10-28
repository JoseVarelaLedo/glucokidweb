import { Injectable, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { getDb } from './firebase-app';
import { InviteItem, UserProfile } from './models';

const DAY = 24 * 3600 * 1000;

/** Código aleatorio de 144 bits (24 caracteres URL-safe): imposible de adivinar. */
function randomCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const CODE_RE = /^[A-Za-z0-9_-]{20,64}$/;

function fromDoc(code: string, x: Record<string, unknown>): InviteItem {
  return {
    code,
    dataUid: String(x['dataUid'] ?? ''),
    spaceName: String(x['spaceName'] ?? ''),
    label: String(x['label'] ?? ''),
    createdByName: String(x['createdByName'] ?? ''),
    createdAt: Number(x['createdAt'] ?? 0),
    expiresAt: Number(x['expiresAt'] ?? 0),
  };
}

/**
 * Invitaciones de alta: el administrador genera un enlace de un solo uso y con caducidad; la persona
 * invitada crea su cuenta desde ese enlace y queda enlazada al niño como usuario normal.
 * Lo que impide abusar es el servidor: las reglas de Firestore (ver firestore.rules).
 */
@Injectable({ providedIn: 'root' })
export class InvitesService {
  private readonly auth = inject(AuthService);
  readonly list = signal<InviteItem[]>([]);

  link(code: string): string {
    return `${location.origin}/unirse/${code}`;
  }

  /** Lectura pública de UNA invitación (hay que conocer su código). Devuelve null si no existe o ya se usó. */
  async peek(code: string): Promise<InviteItem | null> {
    if (!CODE_RE.test(code)) return null;
    const db = await getDb();
    const fs = await import('firebase/firestore');
    const snap = await fs.getDoc(fs.doc(db, 'invites', code));
    return snap.exists() ? fromDoc(code, snap.data()) : null;
  }

  /** Solo administradores. */
  async load(): Promise<void> {
    const db = await getDb();
    const fs = await import('firebase/firestore');
    const snap = await fs.getDocs(fs.collection(db, 'invites'));
    this.list.set(snap.docs.map((d) => fromDoc(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt));
  }

  async create(space: UserProfile, label: string, days: number): Promise<InviteItem> {
    const db = await getDb();
    const fs = await import('firebase/firestore');
    const now = Date.now();
    const item: InviteItem = {
      code: randomCode(),
      dataUid: space.uid,
      spaceName: space.name,
      label: label.trim().slice(0, 60),
      createdByName: this.auth.name(),
      createdAt: now,
      expiresAt: now + days * DAY,
    };
    const { code, ...data } = item;
    await fs.setDoc(fs.doc(db, 'invites', code), data);
    await this.load();
    return item;
  }

  async revoke(code: string): Promise<void> {
    const db = await getDb();
    const fs = await import('firebase/firestore');
    await fs.deleteDoc(fs.doc(db, 'invites', code));
    await this.load();
  }
}
