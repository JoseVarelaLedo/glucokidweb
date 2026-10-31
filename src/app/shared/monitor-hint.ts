import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { hintFor } from '../core/calibration';
import { CalibrationService } from '../core/calibration.service';
import { DataService } from '../core/data.service';
import { Arrow } from '../core/models';

/**
 * Aviso bajo una lectura del monitor: solo aparece cuando el aprendizaje monitor–capilar ya está validado.
 * Es informativo: no sustituye al capilar.
 */
@Component({
  selector: 'app-monitor-hint',
  template: `
    @if (hint(); as h) {
      <p class="mon-hint" [class.care]="h.level === 'cuidado'" [class.ok]="h.level === 'ok'" role="note">
        <span aria-hidden="true">{{ h.level === 'cuidado' ? '⚠' : h.level === 'ok' ? '✓' : 'ℹ' }}</span>
        <span>{{ h.text }}</span>
      </p>
    }
  `,
})
export class MonitorHint {
  private readonly calib = inject(CalibrationService);
  private readonly data = inject(DataService);

  readonly value = input<number | null>(null);
  readonly arrow = input<Arrow | null>(null);
  readonly date = input('');

  protected readonly hint = computed(() => {
    const v = this.value();
    return v === null || !this.date() ? null : hintFor(this.calib.cal(), v, this.arrow(), this.date(), this.data.settings().sensors);
  });

  constructor() {
    effect(() => {
      if (this.value() !== null && this.date()) untracked(() => void this.calib.ensure());
    });
  }
}
