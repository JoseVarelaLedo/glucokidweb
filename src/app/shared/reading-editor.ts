import { Component, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Reading } from '../core/models';
import { nowTime } from '../core/util';
import { ArrowPicker } from './arrow-picker';
import { GlucoseBadge } from './glucose-badge';
import { MonitorHint } from './monitor-hint';

let nextId = 0;

/** Hora + glucemia + flecha (+ clasificación automática). Edita directamente el objeto recibido. */
@Component({
  selector: 'app-reading-editor',
  imports: [FormsModule, ArrowPicker, GlucoseBadge, MonitorHint],
  template: `
    <div class="reading-grid">
      @if (showTime()) {
        <div class="field" [class.missing]="required() && !reading().time">
          <label [attr.for]="uid + '-t'">Hora @if (required()) {<span class="req">*</span>}</label>
          <div class="inline">
            <input [id]="uid + '-t'" type="time" [(ngModel)]="reading().time" />
            <button type="button" class="chip-btn" (click)="setNow()">Ahora</button>
          </div>
        </div>
      }
      <div class="field" [class.missing]="required() && reading().value === null">
        <label [attr.for]="uid + '-v'">Glucemia <small>mg/dL</small> @if (required()) {<span class="req">*</span>}</label>
        <input
          [id]="uid + '-v'"
          type="number"
          inputmode="numeric"
          min="20"
          max="600"
          step="1"
          placeholder="—"
          [(ngModel)]="reading().value"
        />
      </div>
      <div class="field" [class.missing]="required() && !reading().arrow">
        <span class="label">Flecha @if (required()) {<span class="req">*</span>}</span>
        <app-arrow-picker [(arrow)]="reading().arrow" />
      </div>
    </div>
    <app-glucose-badge [value]="reading().value" [arrow]="reading().arrow" />
    @if (hintDate()) {
      <app-monitor-hint [value]="reading().value" [arrow]="reading().arrow" [date]="hintDate()" />
    }
  `,
})
export class ReadingEditor {
  readonly reading = input.required<Reading>();
  readonly showTime = input(true);
  readonly required = input(false);
  /** Fecha del día: si se indica, se muestra el aviso de fiabilidad del monitor (solo para lecturas del monitor). */
  readonly hintDate = input('');
  protected readonly uid = `rd${nextId++}`;

  protected setNow(): void {
    this.reading().time = nowTime();
  }
}
