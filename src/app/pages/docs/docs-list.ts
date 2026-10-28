import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DataService } from '../../core/data.service';
import { DocItem } from '../../core/models';
import { firstHeading } from '../../core/markdown';

export const MAX_DOC_BYTES = 800_000; // Firestore admite 1 MiB por documento

/** Borrador que se pasa al editor (nuevo documento o fichero recién subido). */
export const draftHandoff: { title: string; markdown: string } = { title: '', markdown: '' };

@Component({
  selector: 'app-docs-list',
  imports: [RouterLink],
  template: `
    <section class="card">
      <div class="row between">
        <h2>Documentación</h2>
      </div>
      <p class="muted small">
        Guías, protocolos y teléfonos útiles en Markdown. Cada documento tiene su propio enlace (<code>/docs/nombre</code>) para
        compartirlo con quien tenga acceso a la aplicación. Los enlaces, correos y teléfonos se vuelven pulsables.
      </p>
      <div class="actions">
        <button type="button" class="btn primary" (click)="fileInput.click()">Subir fichero .md</button>
        <button type="button" class="btn ghost" (click)="blank()">+ Escribir uno nuevo</button>
      </div>
      <input #fileInput type="file" hidden accept=".md,.markdown,.txt,text/markdown,text/plain" (change)="onFile($event)" />
      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
    </section>

    @if (loading()) {
      <p class="center muted pad">Cargando documentos…</p>
    } @else {
      <section class="doc-list">
        @for (d of docs(); track d.slug) {
          <a class="card doc-item" [routerLink]="['/docs', d.slug]">
            <strong>{{ d.title }}</strong>
            <span class="muted small">/docs/{{ d.slug }} · actualizado {{ when(d.updatedAt) }}{{ d.updatedBy ? ' por ' + d.updatedBy : '' }}</span>
          </a>
        } @empty {
          <p class="muted">Todavía no hay documentos. Sube un fichero Markdown o escribe el primero.</p>
        }
      </section>
    }
  `,
})
export class DocsList implements OnInit {
  private readonly data = inject(DataService);
  private readonly router = inject(Router);

  protected readonly docs = signal<DocItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');

  async ngOnInit(): Promise<void> {
    try {
      this.docs.set(await this.data.loadDocs());
    } catch (e) {
      this.error.set('No se han podido cargar los documentos. ' + (e instanceof Error ? e.message : ''));
    } finally {
      this.loading.set(false);
    }
  }

  protected when(ms: number): string {
    return ms ? new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  }

  protected blank(): void {
    draftHandoff.title = '';
    draftHandoff.markdown = '';
    void this.router.navigate(['/docs', 'nuevo'], { queryParams: { nuevo: 1 } });
  }

  protected async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.error.set('');
    if (file.size > MAX_DOC_BYTES) {
      this.error.set('El fichero es demasiado grande (máximo ≈ 800 KB de texto).');
      return;
    }
    const text = await file.text();
    if (text.includes('\u0000')) {
      this.error.set('Ese fichero no parece de texto. Sube un .md o .txt.');
      return;
    }
    draftHandoff.markdown = text;
    draftHandoff.title = firstHeading(text) || file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    void this.router.navigate(['/docs', 'nuevo'], { queryParams: { nuevo: 1 } });
  }
}
