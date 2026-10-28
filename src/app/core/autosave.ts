/**
 * guardado automático por comparación de instantáneas: la pantalla edita objetos
 * normales y, en cada ciclo de detección de cambios, se compara su JSON con el
 * último guardado. Si cambió, se guarda tras una breve pausa.
 */
export class AutoSave<T> {
  private snap = '';
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly get: () => T | null,
    private readonly save: (value: T) => Promise<unknown>,
    private readonly delayMs = 700,
  ) {}

  /** hay cambios locales aún sin guardar. */
  get dirty(): boolean {
    return this.pending;
  }

  /** fija el estado actual como "ya guardado" (tras cargar). */
  reset(value: T | null): void {
    clearTimeout(this.timer);
    this.pending = false;
    this.snap = JSON.stringify(value);
  }

  /** llamar desde ngDoCheck. */
  check(): void {
    const v = this.get();
    if (v === null) return;
    const s = JSON.stringify(v);
    if (s === this.snap) return;
    this.snap = s;
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /** guarda ya si hay algo pendiente. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (!this.pending) return;
    this.pending = false;
    const v = this.get();
    if (v === null) return;
    try {
      await this.save(JSON.parse(JSON.stringify(v)) as T);
    } catch {
      // el estado de error ya lo refleja DataService; reintentamos en el siguiente cambio.
      this.pending = true;
    }
  }
}
