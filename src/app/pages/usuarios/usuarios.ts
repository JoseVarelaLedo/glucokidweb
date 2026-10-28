import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { CalcService } from '../../core/calc.service';
import { DataService } from '../../core/data.service';
import { Role, UserProfile } from '../../core/models';
import { InviteItem } from '../../core/models';
import { InvitesService } from '../../core/invites.service';
import { UsersService } from '../../core/users.service';

@Component({
  selector: 'app-usuarios',
  imports: [FormsModule],
  templateUrl: './usuarios.html',
})
export class Usuarios implements OnInit {
  protected readonly users = inject(UsersService);
  protected readonly auth = inject(AuthService);
  protected readonly invites = inject(InvitesService);
  private readonly data = inject(DataService);
  private readonly calc = inject(CalcService);
  private readonly router = inject(Router);

  protected name = '';
  protected email = '';
  protected password = '';
  protected role: Role = 'user';
  /** '' = cuenta con datos propios (un niño nuevo); si no, uid del niño con el que comparte. */
  protected shareWith = '';
  /** Invitaciones */
  protected invSpace = '';
  protected invLabel = '';
  protected invDays = 7;
  protected readonly invBusy = signal(false);
  protected readonly invMsg = signal('');
  protected readonly invErr = signal('');
  protected readonly justCreated = signal<InviteItem | null>(null);
  protected readonly canShare = typeof navigator !== 'undefined' && 'share' in navigator;
  protected readonly busy = signal(false);
  protected readonly msg = signal('');
  protected readonly err = signal('');

  ngOnInit(): void {
    void this.users
      .load()
      .then(() => {
        if (!this.invSpace) this.invSpace = this.data.viewUid() || this.users.spaces()[0]?.uid || '';
      })
      .catch((e) => this.err.set(this.auth.explainCode(e)));
    void this.invites.load().catch(() => undefined);
  }

  protected link(i: InviteItem): string {
    return this.invites.link(i.code);
  }

  protected expired(i: InviteItem): boolean {
    return i.expiresAt <= Date.now();
  }

  protected when(ms: number): string {
    return new Date(ms).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
  }

  protected inviteText(i: InviteItem): string {
    return `Te invito a GlucoKid para compartir los datos de ${i.spaceName}. Crea tu cuenta aquí (el enlace es de un solo uso y caduca el ${this.when(i.expiresAt)}): ${this.link(i)}`;
  }

  protected whatsapp(i: InviteItem): string {
    return 'https://wa.me/?text=' + encodeURIComponent(this.inviteText(i));
  }

  protected async createInvite(): Promise<void> {
    this.invMsg.set('');
    this.invErr.set('');
    const space = this.users.spaces().find((s) => s.uid === this.invSpace);
    if (!space) {
      this.invErr.set('Elige el niño cuyos datos se compartirán.');
      return;
    }
    this.invBusy.set(true);
    try {
      this.justCreated.set(await this.invites.create(space, this.invLabel, this.invDays));
      this.invLabel = '';
    } catch (e) {
      this.invErr.set(this.auth.explainCode(e));
    } finally {
      this.invBusy.set(false);
    }
  }

  protected async copy(i: InviteItem): Promise<void> {
    this.invMsg.set('');
    this.invErr.set('');
    try {
      await navigator.clipboard.writeText(this.link(i));
      this.invMsg.set('Enlace copiado.');
    } catch {
      this.invErr.set('No se ha podido copiar automáticamente: selecciona el enlace y cópialo a mano.');
    }
  }

  protected async share(i: InviteItem): Promise<void> {
    try {
      await navigator.share({ title: 'Invitación a GlucoKid', text: this.inviteText(i) });
    } catch {
      /* cancelado por el usuario */
    }
  }

  protected async revoke(i: InviteItem): Promise<void> {
    this.invErr.set('');
    if (!confirm('¿Anular esta invitación? El enlace dejará de funcionar.')) return;
    try {
      await this.invites.revoke(i.code);
      if (this.justCreated()?.code === i.code) this.justCreated.set(null);
    } catch (e) {
      this.invErr.set(this.auth.explainCode(e));
    }
  }

  protected spaceName(uid: string | undefined): string {
    return this.users.list().find((u) => u.uid === uid)?.name ?? '—';
  }

  /** Cuentas que usan los datos de esta (no se puede convertir en "compartida" si otras dependen de ella). */
  protected dependents(u: UserProfile): number {
    return this.users.list().filter((x) => x.dataUid === u.uid).length;
  }

  protected otherSpaces(u: UserProfile): UserProfile[] {
    return this.users.spaces().filter((s) => s.uid !== u.uid);
  }

  protected async create(): Promise<void> {
    this.msg.set('');
    this.err.set('');
    if (!this.email.trim() || this.password.length < 6) {
      this.err.set('Indica un correo y una contraseña de al menos 6 caracteres.');
      return;
    }
    this.busy.set(true);
    try {
      await this.users.create(this.name, this.email, this.password, this.role, this.shareWith);
      this.msg.set(
        `Cuenta creada para ${this.email.trim()}. Comparte la contraseña inicial de forma segura; puede cambiarla con «Restablecer contraseña».`,
      );
      this.name = this.email = this.password = '';
      this.role = 'user';
      this.shareWith = '';
    } catch (e) {
      this.err.set(this.auth.explainCode(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async update(u: UserProfile, patch: Partial<UserProfile>): Promise<void> {
    this.err.set('');
    try {
      await this.users.save({ ...u, ...patch });
      await this.users.load();
    } catch (e) {
      this.err.set(this.auth.explainCode(e));
    }
  }

  protected async reset(u: UserProfile): Promise<void> {
    this.err.set('');
    this.msg.set('');
    try {
      await this.auth.sendReset(u.email);
      this.msg.set(`Se ha enviado un correo para restablecer la contraseña a ${u.email}.`);
    } catch (e) {
      this.err.set(this.auth.explainCode(e));
    }
  }

  protected async view(u: UserProfile): Promise<void> {
    this.calc.clear();
    await this.router.navigateByUrl('/registro');
    await this.data.switchUser(u.dataUid || u.uid);
  }
}
