import { NgTemplateOutlet } from '@angular/common';
import { Component, input, output } from '@angular/core';
import { Activity, ARROWS, DayRecord, ExtraReading, Meal, Reading } from '../core/models';
import { fmtNum } from '../core/util';
import { DayCurve } from './day-curve';
import { GlucoseBadge } from './glucose-badge';

const ARROW_SYMBOL: Record<string, string> = { up: '↑', upRight: '↗', flat: '→', downRight: '↘', down: '↓' };

/**
 * Instantánea de solo lectura de un día cerrado: mediciones, comidas, administraciones de insulina,
 * anotaciones e incidencias, actividad física y curva de glucemia.
 */
@Component({
  selector: 'app-day-snapshot',
  imports: [NgTemplateOutlet, GlucoseBadge, DayCurve],
  template: `
    <ng-template #rd let-r let-label="label">
      @if (r.value !== null || r.time) {
        <span class="snap-reading">
          @if (r.time) { <span class="mono">{{ r.time }}</span> }
          @if (r.value !== null) {
            <strong>{{ r.value }} mg/dL</strong>
          } @else {
            <span class="muted">sin valor</span>
          }
          @if (r.arrow) { <span class="snap-arrow" [title]="arrowLabel(r.arrow)" [attr.aria-label]="arrowLabel(r.arrow)">{{ arrow(r.arrow) }}</span> }
          @if (label) { <span class="muted small">{{ label }}</span> }
        </span>
        <app-glucose-badge [value]="r.value" [arrow]="r.arrow" [hint]="false" />
      } @else {
        <span class="muted">Sin registrar</span>
      }
    </ng-template>

    <section class="card snap-banner" role="status">
      <div>
        <strong>🔒 Día cerrado · solo lectura</strong>
        <p class="muted small">Es una instantánea de lo que se registró este día; ya no se puede modificar.</p>
      </div>
      @if (canUnlock()) {
        <button type="button" class="btn small ghost" (click)="unlock.emit()">Editar de todos modos</button>
      }
    </section>

    @if (!hasData()) {
      <p class="muted center pad">No hay registros en este día.</p>
    }

    @for (m of shownMeals(); track m.injectionId) {
      <article class="card snap-meal">
        <header>
          <strong>{{ m.name }}</strong>
          <span class="chips">
            @if (m.before.units !== null) {
              <span class="chip">{{ fmt(m.before.units) }} U {{ m.kind === 'lenta' ? 'lenta' : 'rápida' }}</span>
            }
          </span>
        </header>

        <dl class="snap-lines">
          <div>
            <dt>{{ m.kind === 'lenta' ? 'Administración' : 'Antes de comer' }}</dt>
            <dd><ng-container *ngTemplateOutlet="rd; context: { $implicit: m.before }" /></dd>
          </div>

          @if (m.kind === 'rapida') {
            <div>
              <dt>Comida</dt>
              <dd>
                @if (m.foodTime) { <span class="mono">{{ m.foodTime }}</span> }
                @if (m.items.length) {
                  <ul class="snap-items">
                    @for (it of m.items; track it.id) {
                      <li>
                        {{ it.name || 'Sin nombre' }}
                        @if (it.rations !== null && it.rations !== undefined) {
                          <span class="muted"> · {{ rationLabel(it.rations) }}</span>
                        } @else if (it.quantity) {
                          <span class="muted"> · {{ it.quantity }}</span>
                        }
                      </li>
                    }
                  </ul>
                  @if (rations(m) > 0) {
                    <p class="muted small">Total anotado: {{ fmt(rations(m)) }} raciones (≈ {{ fmt(rations(m) * gpr(), 0) }} g de hidratos).</p>
                  }
                } @else {
                  <span class="muted">Sin alimentos anotados</span>
                }
              </dd>
            </div>
            <div>
              <dt>Al terminar</dt>
              <dd><ng-container *ngTemplateOutlet="rd; context: { $implicit: m.after }" /></dd>
            </div>
          }
        </dl>

        @for (x of extrasFor(m); track x.id) {
          <div class="snap-extra">
            <strong>Medición post {{ m.name.toLowerCase() }}</strong>
            <span class="muted small">{{ x.source === 'capilar' ? 'Capilar' : 'Monitor' }}</span>
            <div class="snap-reading-line"><ng-container *ngTemplateOutlet="rd; context: { $implicit: x }" /></div>
            @if (x.extraRations) {
              <p class="small">Raciones adicionales: <strong>{{ fmt(x.extraRations) }}</strong></p>
            }
            @if (x.note) {
              <p class="snap-note">{{ x.note }}</p>
            }
          </div>
        }
      </article>
    }

    @if (day().activities.length) {
      <section class="activities">
        <h3>Actividad física</h3>
        @for (a of day().activities; track a.id) {
          <article class="card snap-meal">
            <header>
              <strong>{{ a.type || 'Actividad' }}</strong>
              <span class="chip"><span class="mono">{{ a.start || '—' }}</span>&nbsp;–&nbsp;<span class="mono">{{ a.end || '—' }}</span></span>
            </header>
            <dl class="snap-lines">
              <div>
                <dt>Antes</dt>
                <dd><ng-container *ngTemplateOutlet="rd; context: { $implicit: noTime(a.before) }" /></dd>
              </div>
              <div>
                <dt>Al terminar</dt>
                <dd><ng-container *ngTemplateOutlet="rd; context: { $implicit: noTime(a.after) }" /></dd>
              </div>
              @if (a.supplemented) {
                <div>
                  <dt>Suplemento</dt>
                  <dd>{{ a.supplementDetail || 'Sí, sin detalle' }}</dd>
                </div>
              }
              @if (a.incident) {
                <div>
                  <dt>Incidencias</dt>
                  <dd class="snap-note">{{ a.incident }}</dd>
                </div>
              }
            </dl>
          </article>
        }
      </section>
    }

    <app-day-curve [day]="day()" />
  `,
})
export class DaySnapshot {
  readonly day = input.required<DayRecord>();
  readonly gramsPerRation = input(10);
  /** Solo los administradores pueden reabrir un día cerrado. */
  readonly canUnlock = input(false);
  readonly unlock = output<void>();

  protected readonly fmt = fmtNum;

  protected gpr(): number {
    return this.gramsPerRation() || 10;
  }

  protected arrow(a: string): string {
    return ARROW_SYMBOL[a] ?? '';
  }
  protected arrowLabel(a: string): string {
    return ARROWS.find((x) => x.key === a)?.label ?? '';
  }

  /** Las actividades guardan su hora en el intervalo, no en la lectura. */
  protected noTime(r: Reading): Reading {
    return { ...r, time: '' };
  }

  protected rationLabel(n: number): string {
    const whole = Math.floor(n);
    const half = n - whole === 0.5;
    if (!half && n !== whole) return `${fmtNum(n, 2)} raciones`;
    const txt = n === 0 ? '0' : half ? (whole ? `${whole}½` : '½') : `${whole}`;
    return `${txt} ${n === 1 ? 'ración' : 'raciones'}`;
  }

  protected rations(m: Meal): number {
    return m.items.reduce((acc, it) => acc + (typeof it.rations === 'number' ? it.rations : 0), 0);
  }

  protected extrasFor(m: Meal): ExtraReading[] {
    return this.day()
      .extras.filter((x) => x.afterInjectionId === m.injectionId)
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  }

  private used(m: Meal): boolean {
    return (
      m.before.value !== null ||
      !!m.before.time ||
      m.before.units !== null ||
      m.after.value !== null ||
      !!m.foodTime ||
      m.items.length > 0 ||
      this.extrasFor(m).length > 0
    );
  }

  /** Se ocultan las comidas opcionales que no se usaron. */
  protected shownMeals(): Meal[] {
    return this.day().meals.filter((m) => !m.optional || this.used(m));
  }

  protected hasData(): boolean {
    const d = this.day();
    return d.meals.some((m) => this.used(m)) || d.activities.length > 0 || d.extras.length > 0;
  }
}

export type { Activity };
