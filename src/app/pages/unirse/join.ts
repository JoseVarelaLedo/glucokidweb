import { Component, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';
import { firebaseEnabled } from '../../core/firebase.config';
import { InviteItem } from '../../core/models';
import { InvitesService } from '../../core/invites.service';

type Phase = 'checking' | 'ready' | 'invalid' | 'expired' | 'unavailable' | 'error';

/** Pantalla pública de alta por invitación (/unirse/<código>). */
@Component({
  selector: 'app-join',
  imports: [FormsModule],
  template: `
    <section class="card login">
      <h1>Unirte a GlucoKid</h1>

      @switch (phase()) {
        @case ('checking') {
          <p class="muted" role="status">Comprobando la invitación…</p>
        }
        @case ('unavailable') {
          <p class="notice">Esta aplicación está en modo local (sin Firebase), así que no admite altas por invitación.</p>
        }
        @case ('invalid') {
          <p class="notice" role="alert">Esta invitación no existe o ya se ha usado. Pide al administrador que te envíe otra.</p>
          <button type="button" class="btn ghost" (click)="leave()">Ir al acceso</button>
        }
        @case ('expired') {
          <p class="notice" role="alert">Esta invitación ha caducado. Pide al administrador que te envíe otra.</p>
          <button type="button" class="btn ghost" (click)="leave()">Ir al acceso</button>
        }
        @case ('error') {
          <p class="error" role="alert">{{ error() }}</p>
          <button type="button" class="btn primary" (click)="check()">Reintentar</button>
        }
        @case ('ready') {
          @if (done()) {
            <p class="notice ok" role="status">¡Listo! Entrando…</p>
          } @else if (auth.status() === 'signedIn' || auth.status() === 'noAccess') {
            <p class="notice">
              Ya has iniciado sesión con {{ auth.email() }}. Para crear una cuenta nueva con esta invitación, cierra antes esa sesión.
            </p>
            <button type="button" class="btn primary" (click)="auth.logout()">Cerrar sesión</button>
            <button type="button" class="btn ghost" (click)="leave()">Volver a la aplicación</button>
          } @else {
            <p class="muted">
              Te han invitado a compartir los datos de <strong>{{ invite()?.spaceName }}</strong>. Crea tu cuenta con tu propio correo y contraseña.
            </p>
            <div class="field">
              <label for="jn-name">Tu nombre (p. ej. «Mamá»)</label>
              <input id="jn-name" type="text" autocomplete="name" maxlength="80" [(ngModel)]="name" />
            </div>
            <div class="field">
              <label for="jn-mail">Correo electrónico</label>
              <input id="jn-mail" type="email" autocomplete="username" inputmode="email" [(ngModel)]="email" />
            </div>
            <div class="field">
              <label for="jn-pass">Contraseña (mín. 6 caracteres)</label>
              <input id="jn-pass" type="password" autocomplete="new-password" [(ngModel)]="password" />
            </div>
            <div class="field">
              <label for="jn-pass2">Repite la contraseña</label>
              <input id="jn-pass2" type="password" autocomplete="new-password" [(ngModel)]="password2" (keyup.enter)="go()" />
            </div>
            @if (error()) {
              <p class="error" role="alert">{{ error() }}</p>
            }
            <button type="button" class="btn primary big" [disabled]="busy()" (click)="go()">
              {{ busy() ? 'Creando cuenta…' : 'Crear mi cuenta' }}
            </button>
          }
        }
      }
    </section>
  `,
})
export class Join implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly invites = inject(InvitesService);

  readonly code = input.required<string>();
  /** Se emite al terminar el alta (o al salir de esta pantalla) para volver a la aplicación. */
  readonly finished = output<void>();

  protected readonly phase = signal<Phase>('checking');
  protected readonly invite = signal<InviteItem | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly done = signal(false);
  protected name = '';
  protected email = '';
  protected password = '';
  protected password2 = '';

  ngOnInit(): void {
    void this.check();
  }

  protected async check(): Promise<void> {
    if (!firebaseEnabled) {
      this.phase.set('unavailable');
      return;
    }
    this.phase.set('checking');
    this.error.set('');
    try {
      const inv = await this.invites.peek(this.code());
      if (!inv) this.phase.set('invalid');
      else if (inv.expiresAt <= Date.now()) this.phase.set('expired');
      else {
        this.invite.set(inv);
        this.phase.set('ready');
      }
    } catch {
      this.error.set('No se ha podido comprobar la invitación. Revisa la conexión e inténtalo de nuevo.');
      this.phase.set('error');
    }
  }

  protected async go(): Promise<void> {
    const inv = this.invite();
    if (!inv || this.busy()) return;
    this.error.set('');
    if (!this.name.trim()) return this.error.set('Indica tu nombre.');
    if (!this.email.trim()) return this.error.set('Indica tu correo electrónico.');
    if (this.password.length < 6) return this.error.set('La contraseña debe tener al menos 6 caracteres.');
    if (this.password !== this.password2) return this.error.set('Las contraseñas no coinciden.');
    this.busy.set(true);
    try {
      await this.auth.registerWithInvite(inv, this.name, this.email, this.password);
      this.done.set(true);
      this.finished.emit();
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (code === 'permission-denied') {
        this.error.set('La invitación ya no es válida (se ha usado o ha caducado). Pide otra al administrador.');
      } else if (code === 'auth/email-already-in-use') {
        this.error.set('Ya existe una cuenta con ese correo. Entra con ella desde la pantalla de acceso y pide al administrador que la enlace al niño.');
      } else {
        this.error.set(this.auth.explainCode(e));
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected leave(): void {
    this.finished.emit();
  }
}
