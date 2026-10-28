import { Component, model } from '@angular/core';
import { ARROWS, Arrow } from '../core/models';

@Component({
  selector: 'app-arrow-picker',
  template: `
    <div class="arrows" role="radiogroup" aria-label="Flecha del monitor">
      @for (a of options; track a.key) {
        <button
          type="button"
          role="radio"
          class="arrow-btn"
          [class.on]="arrow() === a.key"
          [attr.aria-checked]="arrow() === a.key"
          [attr.aria-label]="a.label"
          [title]="a.label"
          (click)="pick(a.key)"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" [style.transform]="'rotate(' + a.deg + 'deg)'">
            <path d="M4 12h15M13 5.5l6.5 6.5-6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      }
    </div>
  `,
})
export class ArrowPicker {
  readonly arrow = model<Arrow | null>(null);
  protected readonly options = ARROWS;

  protected pick(key: Arrow): void {
    this.arrow.set(this.arrow() === key ? null : key);
  }
}
