import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { getDb } from './firebase-app';
import { childrenOf, isCaregiver } from './children';
import { Role, UserProfile } from './models';

/** Gestión de cuentas (solo administradores; las reglas de Firestore lo exigen en el servidor). */
@Injectable({ providedIn: 'root' })
export class UsersService {
  private readonly auth = inject(AuthService);
  readonly list = signal<UserProfile[]>([]);
  /** Cuentas que tienen datos propios (las demás comparten los de otra). */
  readonly spaces = computed(() => this.list().filter((u) => !isCaregiver(u)));
  /** Cómo se llama el niño de un espacio: su «nombre de niño» o, si falta, el de la cuenta. */
  kidLabel(p: UserProfile | undefined | null): string {
    return p?.kidName?.trim() || p?.name || '—';
  }

  /** Cuentas que acceden al niño `uid` (sin contarlo a él mismo). */
  caregiversOf(uid: string): UserProfile[] {
    return this.list().filter((x) => x.uid !== uid && isCaregiver(x) && childrenOf(x).includes(uid));
  }

  async load(): Promise<void> {
    const db = await getDb();
    const fs = await import('firebase/firestore');
    const snap = await fs.getDocs(fs.collection(db, 'users'));
    const users = snap.docs.map((d) => {
      const x = d.data();
      return {
        uid: d.id,
        email: (x['email'] as string) ?? '',
        name: (x['name'] as string) || (x['email'] as string) || d.id,
        role: (x['role'] === 'admin' ? 'admin' : 'user') as Role,
        active: x['active'] !== false,
        dataUid: (x['dataUid'] as string) || '',
        kidName: (x['kidName'] as string) || '',
        dataUids: Array.isArray(x['dataUids']) ? (x['dataUids'] as unknown[]).filter((v): v is string => typeof v === 'string') : [],
      } satisfies UserProfile;
    });
    users.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    this.list.set(users);
  }

  async create(name: string, email: string, password: string, role: Role, dataUid = '', kidName = ''): Promise<void> {
    const uid = await this.auth.createAccount(email, password);
    await this.save({ uid, email: email.trim(), name: name.trim() || email.trim(), role, active: true, dataUid, kidName: dataUid ? '' : kidName });
    await this.load();
  }

  async save(u: UserProfile): Promise<void> {
    const db = await getDb();
    const fs = await import('firebase/firestore');
    await fs.setDoc(fs.doc(db, 'users', u.uid), {
      email: u.email,
      name: u.name,
      role: u.role,
      active: u.active,
      dataUid: u.dataUid || '',
      dataUids: u.dataUids ?? [],
      kidName: u.kidName?.trim() || '',
    });
  }
}
