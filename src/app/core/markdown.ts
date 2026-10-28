/**
 * Markdown → HTML seguro para la sección de documentación.
 *  - `marked` interpreta el Markdown (con enlaces automáticos de URLs y correos).
 *  - Después se enlazan los números de teléfono (tel:).
 *  - `DOMPurify` limpia el resultado: sin scripts, sin imágenes (no se cargan recursos de terceros),
 *    y solo enlaces http(s), mailto y tel.
 */

type Purify = typeof import('dompurify').default;
let purifyPromise: Promise<Purify> | undefined;

function getPurify(): Promise<Purify> {
  purifyPromise ??= import('dompurify').then((m) => {
    const p = m.default;
    p.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') ?? '';
        if (/^https?:/i.test(href)) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
    });
    return p;
  });
  return purifyPromise;
}

/**
 * Teléfonos: 9 dígitos españoles (6-9xx xxx xxx, con espacios, puntos o guiones), internacionales con «+»
 * y los de emergencias 112 / 061 cuando van tras «al» («llama al 112»).
 */
const PHONE_RE = /(\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){7,11})|(?<![\d+])([6-9]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}|[6-9]\d[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2})(?![\d])|(?<=\b[Aa]l )(112|061)\b/g;

function linkifyPhones(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = (n as Text).parentElement;
    if (!el || el.closest('a, code, pre')) continue;
    PHONE_RE.lastIndex = 0;
    if (PHONE_RE.test((n as Text).data)) targets.push(n as Text);
  }
  for (const t of targets) {
    const frag = document.createDocumentFragment();
    const text = t.data;
    let last = 0;
    PHONE_RE.lastIndex = 0;
    for (let m = PHONE_RE.exec(text); m; m = PHONE_RE.exec(text)) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const a = document.createElement('a');
      a.href = 'tel:' + m[0].replace(/[^\d+]/g, '');
      a.textContent = m[0];
      frag.append(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    t.replaceWith(frag);
  }
}

export async function renderMarkdown(md: string): Promise<string> {
  const [{ marked }, purify] = await Promise.all([import('marked'), getPurify()]);
  const raw = marked.parse(md, { gfm: true, breaks: true, async: false }) as string;
  const tpl = document.createElement('template');
  tpl.innerHTML = raw;
  linkifyPhones(tpl.content as unknown as HTMLElement);
  return purify.sanitize(tpl.innerHTML, {
    FORBID_TAGS: ['img', 'style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'svg', 'math'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
    ADD_ATTR: ['target'],
  });
}

/** Primer título «# …» del documento (para proponer el nombre al subir un fichero). */
export function firstHeading(md: string): string {
  const m = /^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/m.exec(md);
  return m ? m[1].replace(/[*_`]/g, '').trim() : '';
}
