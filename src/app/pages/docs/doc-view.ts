import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { DataService } from '../../core/data.service';
import { renderMarkdown } from '../../core/markdown';
import { DocItem } from '../../core/models';
import { slugify } from '../../core/util';
import { MAX_DOC_BYTES, draftHandoff } from './docs-list';

@Component({
  selector: 'app-doc-view',
  imports: [FormsModule, RouterLink],
  template: `
    <p><a routerLink="/docs">← Documentación</a></p>

    @if (loading()) {
      <p class="center muted pad">Cargando…</p>
    } @else if (!editing() && !doc()) {
      <section class="card center pad">
        <h2>Documento no encontrado</h2>
        <p class="muted">No existe un documento con este enlace en los datos de este niño.</p>
      </section>
    } @else if (editing()) {
      <section class="card">
        <h2>{{ isNew() ? 'Nuevo documento' : 'Editar documento' }}</h2>
        <div class="field">
          <label for="dt">Título</label>
          <input id="dt" type="text" [ngModel]="title()" (ngModelChange)="onTitle($event)" />
        </div>
        <div class="field">
          <label for="ds">Enlace (<code>/docs/…</code>)</label>
          <input id="ds" type="text" [ngModel]="slug()" (ngModelChange)="slug.set(clean($event))" [disabled]="!isNew()" />
        </div>
        <div class="field">
          <label for="dm">Contenido (Markdown)</label>
          <textarea id="dm" class="mono" rows="16" [ngModel]="markdown()" (ngModelChange)="markdown.set($event)"></textarea>
        </div>
        <p class="muted small">
          Admite títulos (#), listas, tablas, negritas y enlaces. Las URL, los correos y los teléfonos se enlazan solos. No se muestran imágenes.
        </p>
        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }
        <div class="actions">
          <button type="button" class="btn primary" [disabled]="busy()" (click)="save()">{{ busy() ? 'Guardando…' : 'Guardar' }}</button>
          <button type="button" class="btn ghost" (click)="preview()">Vista previa</button>
          <button type="button" class="btn ghost" (click)="cancel()">Cancelar</button>
        </div>
      </section>
      @if (previewHtml()) {
        <section class="card">
          <h3>Vista previa</h3>
          <div class="prose" [innerHTML]="previewHtml()"></div>
        </section>
      }
    } @else if (doc(); as d) {
      <section class="card">
        <div class="row between">
          <h2>{{ d.title }}</h2>
        </div>
        <p class="muted small">/docs/{{ d.slug }} · actualizado {{ when(d.updatedAt) }}{{ d.updatedBy ? ' por ' + d.updatedBy : '' }}</p>
        <div class="actions">
          <button type="button" class="btn small" (click)="edit()">Editar</button>
          <button type="button" class="btn small ghost" (click)="copyLink()">Copiar enlace</button>
          <button type="button" class="btn small ghost" (click)="download()">Descargar .md</button>
          <button type="button" class="btn small danger" (click)="remove()">Eliminar</button>
        </div>
        @if (msg()) {
          <p class="notice ok" role="status">{{ msg() }}</p>
        }
      </section>
      <section class="card">
        <div class="prose" [innerHTML]="html()"></div>
      </section>
    }
  `,
})
export class DocView implements OnInit {
  private readonly data = inject(DataService);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly loading = signal(true);
  protected readonly doc = signal<DocItem | null>(null);
  protected readonly editing = signal(false);
  protected readonly isNew = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly msg = signal('');
  protected readonly title = signal('');
  protected readonly slug = signal('');
  protected readonly markdown = signal('');
  private slugTouched = false;

  private readonly rendered = signal('');
  private readonly rendPreview = signal('');
  // El HTML ya viene sanitizado por DOMPurify (ver core/markdown.ts); se marca como seguro para que Angular no lo recorte.
  protected readonly html = computed<SafeHtml>(() => this.sanitizer.bypassSecurityTrustHtml(this.rendered()));
  protected readonly previewHtml = computed<SafeHtml | null>(() =>
    this.rendPreview() ? this.sanitizer.bypassSecurityTrustHtml(this.rendPreview()) : null,
  );

  async ngOnInit(): Promise<void> {
    const slug = this.route.snapshot.paramMap.get('slug') ?? '';
    if (slug === 'nuevo' && this.route.snapshot.queryParamMap.has('nuevo')) {
      this.isNew.set(true);
      this.title.set(draftHandoff.title);
      this.markdown.set(draftHandoff.markdown);
      this.slug.set(slugify(draftHandoff.title));
      this.slugTouched = false;
      this.editing.set(true);
      this.loading.set(false);
      return;
    }
    try {
      const d = await this.data.loadDoc(slug);
      this.doc.set(d);
      if (d) this.rendered.set(await renderMarkdown(d.markdown));
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : 'Error al cargar');
    } finally {
      this.loading.set(false);
    }
  }

  protected when(ms: number): string {
    return ms ? new Date(ms).toLocaleString('es-ES', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  }

  protected clean(s: string): string {
    this.slugTouched = true;
    return slugify(s);
  }

  protected onTitle(t: string): void {
    this.title.set(t);
    if (this.isNew() && !this.slugTouched) this.slug.set(slugify(t));
  }

  protected edit(): void {
    const d = this.doc();
    if (!d) return;
    this.title.set(d.title);
    this.slug.set(d.slug);
    this.markdown.set(d.markdown);
    this.rendPreview.set('');
    this.error.set('');
    this.editing.set(true);
  }

  protected cancel(): void {
    if (this.isNew()) void this.router.navigate(['/docs']);
    else this.editing.set(false);
  }

  protected async preview(): Promise<void> {
    this.rendPreview.set(await renderMarkdown(this.markdown()));
  }

  protected async save(): Promise<void> {
    this.error.set('');
    const title = this.title().trim();
    const slug = this.slug();
    const md = this.markdown();
    if (!title || !slug) {
      this.error.set('Indica un título y un enlace.');
      return;
    }
    if (new Blob([md]).size > MAX_DOC_BYTES) {
      this.error.set('El documento es demasiado grande (máximo ≈ 800 KB).');
      return;
    }
    this.busy.set(true);
    try {
      if (this.isNew() && (await this.data.loadDoc(slug))) {
        this.error.set('Ya existe un documento con ese enlace. Cambia el enlace o edita el existente.');
        return;
      }
      const item: DocItem = { slug, title, markdown: md, updatedAt: Date.now(), updatedBy: this.auth.name() };
      await this.data.saveDoc(item);
      if (this.isNew()) {
        await this.router.navigate(['/docs', slug], { replaceUrl: true });
        return;
      }
      this.doc.set(item);
      this.rendered.set(await renderMarkdown(md));
      this.editing.set(false);
    } catch (e) {
      this.error.set('No se ha podido guardar. ' + (e instanceof Error ? e.message : ''));
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const d = this.doc();
    if (!d || !confirm(`¿Eliminar «${d.title}»? Esta acción no se puede deshacer.`)) return;
    await this.data.deleteDoc(d.slug);
    await this.router.navigate(['/docs']);
  }

  protected async copyLink(): Promise<void> {
    const d = this.doc();
    if (!d) return;
    const url = `${location.origin}/docs/${d.slug}`;
    try {
      await navigator.clipboard.writeText(url);
      this.msg.set('Enlace copiado: ' + url);
    } catch {
      this.msg.set('Enlace: ' + url);
    }
  }

  protected download(): void {
    const d = this.doc();
    if (!d) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([d.markdown], { type: 'text/markdown' }));
    a.download = `${d.slug}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
}
