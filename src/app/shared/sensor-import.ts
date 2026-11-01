import { Component, computed, inject, output, signal } from '@angular/core';
import { CalibrationService } from '../core/calibration.service';
import { DataService } from '../core/data.service';
import { LibreCsvError, LibreParse, MAX_CSV_BYTES, decodeCsv, parseLibreCsv } from '../core/libre-csv';
import { mergeSeries, seriesByDay } from '../core/libre-import';
import { fmtNum, todayStr } from '../core/util';

interface Preview {
  parse: LibreParse;
  series: Map<string, number[]>;
  days: number;
  readings: number;
  added: number;
  changed: number;
  /** Fechas con un evento del sensor que todavía no están anotadas como cambio de sensor. */
  events: string[];
}

const dmy = (d: string): string => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

/**
 * Importa el CSV que se descarga de la web del monitor (FreeStyle Libre / LibreView) y lo guarda como serie continua de cada día,
 * para verla en la gráfica y en las instantáneas. No rellena las mediciones manuales ni cambia dosis.
 * El nombre del archivo y la primera línea (que lleva el nombre del niño) no se muestran ni se guardan.
 */
@Component({
  selector: 'app-sensor-import',
  template: `
    <section class="card sensor-import">
      <h3>Importar datos del sensor</h3>
      <p class="muted small">
        Descarga el CSV de glucosa desde la web del monitor y súbelo aquí (por ejemplo una vez por semana). Las lecturas continuas se
        guardan en cada día y aparecen en su gráfica y en sus instantáneas. Las mediciones que anotas a mano no se tocan.
      </p>
      <div class="row gap">
        <label class="btn small primary file-btn" for="sensor-file">{{ busy() ? 'Leyendo…' : 'Elegir archivo CSV…' }}</label>
        <input id="sensor-file" class="sr-only" type="file" accept=".csv,text/csv,text/plain" [disabled]="busy()" (change)="onFile($event)" />
      </div>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (done()) {
        <p class="notice" role="status">{{ done() }}</p>
      }

      @if (preview(); as p) {
        <div class="sensor-preview">
          <p>
            <strong>{{ fmt(p.parse.history.length, 0) }}</strong> lecturas continuas del
            <strong>{{ dmy(p.parse.first) }}</strong> al <strong>{{ dmy(p.parse.last) }}</strong> ({{ p.days }} {{ p.days === 1 ? 'día' : 'días' }}).
          </p>
          <ul class="sensor-facts">
            <li><strong>{{ fmt(p.added, 0) }}</strong> lecturas nuevas se guardarán.</li>
            @if (p.readings - p.added - p.changed > 0) {
              <li>{{ fmt(p.readings - p.added - p.changed, 0) }} ya estaban guardadas.</li>
            }
            @if (p.changed) {
              <li>{{ fmt(p.changed, 0) }} se sustituirán porque la misma hora tenía otro valor.</li>
            }
          </ul>
          <p class="muted small">
            No se importan: {{ p.parse.scans.length }} {{ p.parse.scans.length === 1 ? 'escaneo' : 'escaneos' }},
            {{ p.parse.strips.length }} {{ p.parse.strips.length === 1 ? 'glucemia de tira' : 'glucemias de tira' }}, insulina, comidas ni notas.
            @if (p.parse.ignored) { {{ p.parse.ignored }} {{ p.parse.ignored === 1 ? 'línea' : 'líneas' }} con fecha o valor ilegibles se han saltado. }
            @if (p.parse.unit === 'mmol/L') { Valores convertidos de mmol/L a mg/dL. }
          </p>

          @if (p.events.length) {
            <fieldset class="sensor-events">
              <legend>Eventos del sensor en el archivo</legend>
              <p class="muted small">
                Pueden ser arranques o cambios de sensor, pero el archivo no lo dice con certeza. Marca solo los que sepas que fueron un
                cambio de sensor para anotarlos en la pestaña Monitor.
              </p>
              @for (e of p.events; track e) {
                <label class="check"><input type="checkbox" [checked]="picked().has(e)" (change)="toggle(e)" /> {{ dmy(e) }}</label>
              }
            </fieldset>
          }

          <div class="row gap">
            <button type="button" class="btn primary" [disabled]="busy() || (!p.added && !p.changed && !picked().size)" (click)="apply()">
              {{ busy() ? 'Importando…' : 'Importar' }}
            </button>
            <button type="button" class="btn ghost" [disabled]="busy()" (click)="clear()">Cancelar</button>
          </div>
        </div>
      }
    </section>
  `,
})
export class SensorImport {
  private readonly data = inject(DataService);
  private readonly calib = inject(CalibrationService);
  readonly imported = output<void>();

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly done = signal('');
  protected readonly preview = signal<Preview | null>(null);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  protected readonly fmt = fmtNum;
  protected readonly dmy = dmy;
  protected readonly hasPreview = computed(() => this.preview() !== null);

  protected clear(): void {
    this.preview.set(null);
    this.picked.set(new Set());
  }

  protected toggle(d: string): void {
    this.picked.update((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });
  }

  protected async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // permite elegir de nuevo el mismo archivo
    this.error.set('');
    this.done.set('');
    this.clear();
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) {
      this.error.set('El archivo es demasiado grande para ser la exportación del monitor.');
      return;
    }
    this.busy.set(true);
    try {
      const parse = parseLibreCsv(decodeCsv(await file.arrayBuffer()));
      const series = seriesByDay(parse, todayStr());
      if (!series.size) {
        this.error.set('El archivo no trae lecturas continuas (historial) que importar.');
        return;
      }
      // Qué hay ya guardado, para decir cuántas lecturas son nuevas.
      const stored = await this.data.getRange(parse.first, parse.last);
      const byDate = new Map(stored.map((d) => [d.date, d.sensor]));
      let readings = 0;
      let added = 0;
      let changed = 0;
      for (const [date, inc] of series) {
        const r = mergeSeries(byDate.get(date), inc);
        readings += inc.length / 2;
        added += r.added;
        changed += r.changed;
      }
      const known = new Set(this.data.settings().sensors ?? []);
      const today = todayStr();
      this.preview.set({
        parse,
        series,
        days: series.size,
        readings,
        added,
        changed,
        events: parse.eventDates.filter((d) => d <= today && !known.has(d)),
      });
    } catch (e) {
      this.error.set(e instanceof LibreCsvError ? e.message : 'No se ha podido leer el archivo. ' + (e instanceof Error ? e.message : ''));
    } finally {
      this.busy.set(false);
    }
  }

  protected async apply(): Promise<void> {
    const p = this.preview();
    if (!p || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const r = await this.data.importSensor(p.series);
      const sensors = [...this.picked()];
      if (sensors.length) {
        const list = [...new Set([...(this.data.settings().sensors ?? []), ...sensors])].sort();
        this.data.settings.update((s) => ({ ...s, sensors: list }));
        await this.data.saveSettings(this.data.settings());
        void this.calib.reload();
      }
      this.done.set(
        r.added || r.changed
          ? `Importadas ${fmtNum(r.added + r.changed, 0)} lecturas en ${r.days} ${r.days === 1 ? 'día' : 'días'}.` +
              (sensors.length ? ` ${sensors.length} ${sensors.length === 1 ? 'cambio' : 'cambios'} de sensor anotado${sensors.length === 1 ? '' : 's'}.` : '')
          : sensors.length
            ? `Anotados ${sensors.length} cambio${sensors.length === 1 ? '' : 's'} de sensor. No había lecturas nuevas.`
            : 'No había nada nuevo que importar.',
      );
      this.clear();
      this.imported.emit();
    } catch (e) {
      this.error.set('No se ha podido guardar la importación. Puedes volver a intentarlo: lo ya guardado no se duplica. ' + (e instanceof Error ? e.message : ''));
    } finally {
      this.busy.set(false);
    }
  }
}
