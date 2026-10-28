import { Component, computed, input } from '@angular/core';
import { classify } from '../core/glucose';
import { Arrow } from '../core/models';

@Component({
  selector: 'app-glucose-badge',
  template: `
    @if (info(); as i) {
      <span [class]="'badge c-' + i.cls"><span aria-hidden="true">{{ i.icon }}</span> {{ i.label }}</span>
      @if (hint() && i.cls === 'hipo') {
        <p class="hint">Actúa según el protocolo de hipoglucemia que os haya dado el equipo médico.</p>
      }
    }
  `,
})
export class GlucoseBadge {
  readonly value = input<number | null>(null);
  readonly arrow = input<Arrow | null>(null);
  readonly hint = input(true);
  protected readonly info = computed(() => classify(this.value(), this.arrow()));
}
