import { DayRecord, Food, InjectionDef, Meal, PredictModel, RationPlan, Reading, Settings } from './models';

export function emptyReading(): Reading {
  return { time: '', value: null, arrow: null };
}

export const SETTINGS_VERSION = 2;

/** Total de raciones previstas de una comida (harinas + verduras + fruta). */
export function planTotal(p?: RationPlan | null): number {
  return (p?.harinas ?? 0) + (p?.verduras ?? 0) + (p?.fruta ?? 0);
}

export function makeDefaultModel(): PredictModel {
  return { diaMin: 300, peakMin: 75, carbMin: 180, carbMinFat: 240 };
}

export function makeDefaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    dailyCalories: null,
    carbPercent: 50,
    dailyRapid: null,
    dailyLenta: null,
    isf: null,
    targetGlucose: 150,
    model: makeDefaultModel(),
    injections: [
      { id: 'desayuno', name: 'Desayuno', kind: 'rapida', maxUnits: 20 },
      { id: 'mediamanana', name: 'Media mañana', kind: 'rapida', maxUnits: 20, optional: true },
      { id: 'comida', name: 'Comida', kind: 'rapida', maxUnits: 20 },
      { id: 'merienda', name: 'Merienda', kind: 'rapida', maxUnits: 20 },
      { id: 'cena', name: 'Cena', kind: 'rapida', maxUnits: 20 },
      { id: 'lenta', name: 'Insulina lenta', kind: 'lenta', maxUnits: 40 },
    ],
    doseStep: 0.5,
    gramsPerRation: 10,
    unitsPerRation: 1,
  };
}

/**
 * Pone al día unos ajustes guardados con una versión anterior sin perder nada:
 *  - v2: añade "Media mañana" (opcional) tras el desayuno y los campos nuevos.
 * Devuelve true si ha cambiado algo (para guardarlos).
 */
export function migrateSettings(s: Settings): boolean {
  let changed = false;
  const def = makeDefaultSettings();
  if ((s.version ?? 1) < 2) {
    if (!s.injections.some((i) => i.id === 'mediamanana')) {
      const at = s.injections.findIndex((i) => i.id === 'desayuno');
      const pos = at >= 0 ? at + 1 : Math.min(1, s.injections.length);
      s.injections.splice(pos, 0, { id: 'mediamanana', name: 'Media mañana', kind: 'rapida', maxUnits: 20, optional: true });
    }
    s.version = 2;
    changed = true;
  }
  for (const k of ['dailyCalories', 'carbPercent', 'dailyRapid', 'dailyLenta', 'isf', 'targetGlucose'] as const) {
    if (s[k] === undefined) {
      (s as unknown as Record<string, unknown>)[k] = def[k];
      changed = true;
    }
  }
  // Ya no hay elección de regla: el factor de sensibilidad usa siempre la constante 1700
  if ('isfRule' in (s as object)) {
    delete (s as { isfRule?: number }).isfRule;
    changed = true;
  }
  if (!s.model) {
    s.model = makeDefaultModel();
    changed = true;
  }
  return changed;
}

/**
 * Las mediciones intermedias ya no cuelgan de la insulina lenta: se reasignan a la
 * última comida de rápida anterior ("Mediciones post cena"). Se aplica al leer un día.
 */
export function normalizeExtras(day: DayRecord): void {
  for (const x of day.extras) {
    const idx = day.meals.findIndex((m) => m.injectionId === x.afterInjectionId);
    if (idx < 0 || day.meals[idx].kind !== 'lenta') continue;
    for (let j = idx - 1; j >= 0; j--) {
      if (day.meals[j].kind === 'rapida') {
        x.afterInjectionId = day.meals[j].injectionId;
        break;
      }
    }
  }
}

export function newMeal(inj: InjectionDef): Meal {
  return {
    injectionId: inj.id,
    name: inj.name,
    kind: inj.kind,
    optional: !!inj.optional,
    before: { ...emptyReading(), units: null },
    foodTime: '',
    items: [],
    after: emptyReading(),
  };
}

export function newDay(date: string, s: Settings): DayRecord {
  return { date, meals: s.injections.map(newMeal), extras: [], activities: [] };
}

/**
 * Para hoy y días futuros, alinea el día con la configuración actual
 * (nuevas administraciones, nombres). Los días pasados no se tocan.
 */
export function syncDay(day: DayRecord, s: Settings, today: string): DayRecord {
  if (day.date < today) return day;
  for (const inj of s.injections) {
    const m = day.meals.find((x) => x.injectionId === inj.id);
    if (!m) {
      day.meals.push(newMeal(inj));
    } else {
      m.name = inj.name;
      m.kind = inj.kind;
      m.optional = !!inj.optional;
    }
  }
  // Mismo orden que la pauta (las comidas que ya no existan quedan al final)
  const order = (id: string) => {
    const i = s.injections.findIndex((x) => x.id === id);
    return i < 0 ? 999 : i;
  };
  day.meals.sort((a, b) => order(a.injectionId) - order(b.injectionId));
  return day;
}

export const FOOD_GROUPS = [
  'Cereales, pasta y pan',
  'Legumbres',
  'Hortalizas con hidratos',
  'Fruta',
  'Lácteos',
  'Proteínas y grasas (sin hidratos)',
  'Verduras verdes (sin hidratos)',
  'Otros',
] as const;

const [CER, LEG, HOR, FRU, LAC, PRO, VER] = FOOD_GROUPS;

const f = (id: string, name: string, group: string, carbsPer100g: number): Food => ({ id, name, group, carbsPer100g });

/**
 * Valores ORIENTATIVOS de hidratos de carbono por 100 g (alimento cocido/preparado
 * salvo indicación). Proceden de composiciones medias habituales y son totalmente
 * editables en la pantalla "Alimentos": contrástalos con la tabla de raciones que use
 * vuestro equipo de endocrinología.
 */
export function makeDefaultFoods(): Food[] {
  return [
    f('pasta-cocida', 'Pasta cocida', CER, 25),
    f('arroz-cocido', 'Arroz cocido', CER, 28),
    f('cuscus-cocido', 'Cuscús cocido', CER, 23),
    f('pan-blanco', 'Pan blanco', CER, 50),
    f('pan-integral', 'Pan integral', CER, 43),
    f('pan-molde', 'Pan de molde', CER, 49),
    f('galletas-maria', 'Galletas tipo María', CER, 75),
    f('copos-maiz', 'Copos de maíz (cereales)', CER, 84),

    f('lentejas-cocidas', 'Lentejas cocidas', LEG, 18),
    f('garbanzos-cocidos', 'Garbanzos cocidos', LEG, 21),
    f('alubias-cocidas', 'Alubias cocidas', LEG, 18),
    f('guisantes-cocidos', 'Guisantes cocidos', LEG, 11),

    f('patata-cocida', 'Patata cocida', HOR, 17),
    f('patata-frita', 'Patatas fritas (caseras)', HOR, 33),
    f('boniato-cocido', 'Boniato cocido', HOR, 20),
    f('zanahoria-cocida', 'Zanahoria cocida', HOR, 7),
    f('remolacha-cocida', 'Remolacha cocida', HOR, 9),
    f('maiz-dulce', 'Maíz dulce', HOR, 17),
    f('calabaza-cocida', 'Calabaza cocida', HOR, 6),

    f('manzana', 'Manzana', FRU, 12),
    f('platano', 'Plátano', FRU, 21),
    f('naranja', 'Naranja', FRU, 9),
    f('mandarina', 'Mandarina', FRU, 10),
    f('pera', 'Pera', FRU, 12),
    f('melocoton', 'Melocotón', FRU, 9),
    f('kiwi', 'Kiwi', FRU, 11),
    f('uvas', 'Uvas', FRU, 16),
    f('fresas', 'Fresas', FRU, 6),
    f('sandia', 'Sandía', FRU, 7),
    f('melon', 'Melón', FRU, 6),

    f('leche', 'Leche', LAC, 5),
    f('yogur-natural', 'Yogur natural', LAC, 5),
    f('yogur-azucarado', 'Yogur azucarado / de sabores', LAC, 14),
    f('queso', 'Queso', LAC, 0),

    f('pollo', 'Pollo', PRO, 0),
    f('ternera', 'Ternera', PRO, 0),
    f('cerdo', 'Cerdo', PRO, 0),
    f('pescado-blanco', 'Pescado blanco', PRO, 0),
    f('salmon', 'Salmón', PRO, 0),
    f('atun', 'Atún', PRO, 0),
    f('huevo', 'Huevo', PRO, 0),
    f('jamon-cocido', 'Jamón cocido', PRO, 0),
    f('aceite-oliva', 'Aceite de oliva', PRO, 0),

    f('brocoli', 'Brócoli', VER, 0),
    f('judias-verdes', 'Judías verdes', VER, 0),
    f('espinacas', 'Espinacas', VER, 0),
    f('acelgas', 'Acelgas', VER, 0),
    f('lechuga', 'Lechuga', VER, 0),
    f('calabacin', 'Calabacín', VER, 0),
    f('esparragos', 'Espárragos', VER, 0),
    f('pepino', 'Pepino', VER, 0),
  ];
}
