import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <section class="card login">
      <h1>Acceso familiar</h1>
      <p class="muted">Los datos de salud están protegidos: solo pueden verlos las cuentas autorizadas.</p>
      <div class="field">
        <label for="lg-mail">Correo electrónico</label>
        <input id="lg-mail" type="email" autocomplete="username" inputmode="email" [(ngModel)]="email" (keyup.enter)="go()" />
      </div>
      <div class="field">
        <label for="lg-pass">Contraseña</label>
        <input id="lg-pass" type="password" autocomplete="current-password" [(ngModel)]="password" (keyup.enter)="go()" />
      </div>
      @if (auth.error()) {
        <p class="error" role="alert">{{ auth.error() }}</p>
      }
      <button type="button" class="btn primary big" [disabled]="auth.busy() || !email || !password" (click)="go()">
        {{ auth.busy() ? 'Entrando…' : 'Entrar' }}
      </button>
    </section>
  `,
})
export class Login {
  protected readonly auth = inject(AuthService);
  protected email = '';
  protected password = '';
  protected readonly shown = signal(false);

  protected go(): void {
    if (this.email && this.password) void this.auth.login(this.email, this.password);
  }
}
