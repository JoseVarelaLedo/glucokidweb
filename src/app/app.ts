import { Component, OnInit, effect, inject, signal, untracked } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AlertsService } from './core/alerts.service';
import { AuthService } from './core/auth.service';
import { DataService } from './core/data.service';
import { CalcService } from './core/calc.service';
import { LayoutService } from './core/layout.service';
import { PushService } from './core/push.service';
import { UsersService } from './core/users.service';
import { Login } from './pages/login/login';
import { Join } from './pages/unirse/join';

/** Código de invitación si la URL es /unirse/<código>; si no, ''. */
const joinCodeOf = (url: string): string => /^\/unirse\/([A-Za-z0-9_-]{1,100})/.exec(url.split(/[?#]/)[0])?.[1] ?? '';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Login, Join],
  templateUrl: './app.html',
})
export class App implements OnInit {
  protected readonly auth = inject(AuthService);
  protected readonly data = inject(DataService);
  protected readonly layout = inject(LayoutService);
  protected readonly users = inject(UsersService);
  protected readonly alerts = inject(AlertsService);
  private readonly push = inject(PushService);
  private readonly calc = inject(CalcService);
  private readonly router = inject(Router);

  /** Pantalla de alta por invitación (pública): se muestra en lugar del acceso y de la aplicación. */
  protected readonly joinCode = signal(joinCodeOf(location.pathname));

  constructor() {
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) this.joinCode.set(joinCodeOf(e.urlAfterRedirects));
    });
    // En cuanto hay sesión (o modo local) cargamos configuración y alimentos.
    effect(() => {
      const s = this.auth.status();
      if (s === 'signedIn' || s === 'local') {
        untracked(() => {
          void this.data.init();
          if (this.auth.isAdmin()) void this.users.load().catch(() => undefined);
        });
      }
    });
  }

  ngOnInit(): void {
    void this.auth.init();
  }

  /** Los avisos entre cuidadores se escuchan mientras haya datos cargados (y se reinician al cambiar de niño). */
  private readonly watchAlerts = effect(() => {
    const ready = this.data.ready();
    untracked(() => {
      if (ready) {
        this.alerts.start();
        void this.push.refresh();
      } else this.alerts.stop();
    });
  });

  protected endJoin(): void {
    void this.router.navigateByUrl('/registro');
  }

  protected switchUser(uid: string): void {
    this.calc.clear();
    void this.data.switchUser(uid);
  }

  protected viewingName(): string {
    return this.users.kidLabel(this.users.spaces().find((u) => u.uid === this.data.viewUid()));
  }
}
