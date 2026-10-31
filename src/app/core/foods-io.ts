import { Food } from './models';
import { round, uid } from './util';

/** Importación y exportación de alimentos en JSON. */

export const FOODS_FORMAT = 'glucokid-alimentos';
export const MAX_FOODS = 2000;
export const MAX_FILE_BYTES = 1024 * 1024;

export interface FoodsFile {
  app: typeof FOODS_FORMAT;
  version: 1;
  exportedAt: string;
  /** Gramos de hidratos que son una ración (el valor de Ajustes en el momento de exportar). */
  carbsPerRation: number;
  foods: Array<{
    name: string;
    group: string;
    /** Gramos de ESTE alimento que aportan una ración de hidratos (null si no tiene hidratos). */
    gramsPerRation: number | null;
    /** Gramos de hidratos por cada 100 g de alimento. */
    carbsPer100g: number;
  }>;
}

export function foodsToJson(foods: Food[], carbsPerRation: number): string {
  const out: FoodsFile = {
    app: FOODS_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    carbsPerRation,
    foods: [...foods]
      .sort((a, b) => a.group.localeCompare(b.group, 'es') || a.name.localeCompare(b.name, 'es'))
      .map((f) => ({
        name: f.name,
        group: f.group,
        gramsPerRation: f.carbsPer100g > 0 ? round((carbsPerRation * 100) / f.carbsPer100g, 1) : null,
        carbsPer100g: round(f.carbsPer100g, 4),
      })),
  };
  return JSON.stringify(out, null, 2);
}

export const normName = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export type ImportStatus = 'nuevo' | 'actualiza' | 'igual';

export interface ImportItem {
  food: Food;
  status: ImportStatus;
}

export interface ImportPreview {
  items: ImportItem[];
  /** Entradas descartadas, con el motivo. */
  errors: string[];
  warnings: string[];
  counts: { nuevo: number; actualiza: number; igual: number };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : null);

/**
 * Lee y valida el texto de un archivo. Admite el formato exportado por la aplicación o una lista simple de alimentos.
 * Nunca lanza: los problemas se devuelven en `errors`.
 */
export function parseFoodsJson(text: string, existing: Food[], currentCarbsPerRation: number): ImportPreview {
  const empty = (msg: string): ImportPreview => ({ items: [], errors: [msg], warnings: [], counts: { nuevo: 0, actualiza: 0, igual: 0 } });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty('El archivo no es un JSON válido.');
  }
  let list: unknown;
  let fileRation = currentCarbsPerRation;
  const warnings: string[] = [];
  if (Array.isArray(raw)) list = raw;
  else if (isObj(raw)) {
    if (raw['app'] !== undefined && raw['app'] !== FOODS_FORMAT) return empty('El archivo no es una lista de alimentos de GlucoKid.');
    list = raw['foods'];
    const r = num(raw['carbsPerRation']);
    if (r !== null && r > 0 && r <= 100) fileRation = r;
    if (fileRation !== currentCarbsPerRation) {
      warnings.push(`El archivo usa raciones de ${fileRation} g de hidratos y en Ajustes tienes ${currentCarbsPerRation} g. Los «gramos por ración» se han convertido a hidratos con ${fileRation} g.`);
    }
  } else return empty('El archivo no tiene el formato esperado.');
  if (!Array.isArray(list)) return empty('No se encuentra la lista «foods» de alimentos.');
  if (list.length === 0) return empty('La lista de alimentos está vacía.');
  if (list.length > MAX_FOODS) return empty(`Demasiados alimentos (${list.length}); el máximo es ${MAX_FOODS}.`);

  const errors: string[] = [];
  const byName = new Map<string, Food>(); // dentro del archivo, gana el último
  list.forEach((entry, i) => {
    const at = `Alimento ${i + 1}`;
    if (!isObj(entry)) return void errors.push(`${at}: no es un objeto.`);
    const name = typeof entry['name'] === 'string' ? entry['name'].replace(/\s+/g, ' ').trim() : '';
    if (!name) return void errors.push(`${at}: falta el nombre.`);
    if (name.length > 80) return void errors.push(`«${name.slice(0, 30)}…»: el nombre supera los 80 caracteres.`);
    const group = typeof entry['group'] === 'string' && entry['group'].trim() ? entry['group'].trim().slice(0, 60) : 'Otros';

    const carbs = num(entry['carbsPer100g']);
    const grams = entry['gramsPerRation'] === null ? 0 : num(entry['gramsPerRation']);
    let c100: number;
    if (carbs !== null) {
      if (carbs < 0 || carbs > 100) return void errors.push(`«${name}»: los hidratos por 100 g deben estar entre 0 y 100.`);
      c100 = carbs;
      if (grams && grams > 0 && Math.abs((fileRation * 100) / grams - carbs) > Math.max(1, carbs * 0.1)) {
        warnings.push(`«${name}»: los gramos por ración no coinciden con los hidratos por 100 g; se usan los hidratos por 100 g.`);
      }
    } else if (grams !== null) {
      if (grams === 0) c100 = 0;
      else if (grams < 0 || grams > 10000) return void errors.push(`«${name}»: los gramos por ración no son válidos.`);
      else {
        c100 = (fileRation * 100) / grams;
        if (c100 > 100) return void errors.push(`«${name}»: una ración de ${fileRation} g de hidratos no puede pesar solo ${grams} g.`);
      }
    } else return void errors.push(`«${name}»: indica «carbsPer100g» o «gramsPerRation».`);

    if (byName.has(normName(name))) warnings.push(`«${name}» aparece repetido en el archivo; se usa la última entrada.`);
    byName.set(normName(name), { id: '', name, group, carbsPer100g: round(c100, 4) });
  });

  const exByName = new Map(existing.map((f) => [normName(f.name), f]));
  const counts = { nuevo: 0, actualiza: 0, igual: 0 };
  const items: ImportItem[] = [];
  for (const [key, f] of byName) {
    const ex = exByName.get(key);
    let status: ImportStatus;
    if (!ex) {
      status = 'nuevo';
      f.id = uid();
    } else {
      f.id = ex.id;
      status = ex.group === f.group && Math.abs(ex.carbsPer100g - f.carbsPer100g) < 0.0001 && ex.name === f.name ? 'igual' : 'actualiza';
    }
    counts[status]++;
    items.push({ food: f, status });
  }
  if (errors.length > 30) warnings.push(`Hay ${errors.length} entradas con errores; se muestran las 30 primeras.`);
  return { items, errors: errors.slice(0, 30), warnings: warnings.slice(0, 20), counts };
}

/** Aplica la importación: «añadir» mezcla con el catálogo; «reemplazar» lo sustituye por completo. */
export function applyImport(existing: Food[], preview: ImportPreview, mode: 'mezclar' | 'reemplazar'): Food[] {
  const incoming = preview.items.map((i) => i.food);
  if (mode === 'reemplazar') return incoming;
  const ids = new Set(incoming.map((f) => f.id));
  return [...existing.filter((f) => !ids.has(f.id)), ...incoming];
}
