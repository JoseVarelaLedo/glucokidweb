export type Arrow = 'up' | 'upRight' | 'flat' | 'downRight' | 'down';
export type MeasureSource = 'monitor' | 'capilar';
export type InjectionKind = 'rapida' | 'lenta';

/** Lectura de glucemia: valor + flecha del monitor + hora. */
export interface Reading {
  time: string; // HH:mm
  value: number | null; // mg/dL
  arrow: Arrow | null;
}

/** Las 4 lecturas obligatorias de cada administración: hora, glucemia, flecha y unidades. */
export interface MealReading extends Reading {
  units: number | null;
}

export interface FoodEntry {
  id: string;
  name: string;
  /** Texto libre de cantidad (versión anterior, p. ej. «200 g»). Solo se usa si `rations` no está informado. */
  quantity: string;
  /** Raciones de hidratos de este alimento (en pasos de media ración). Es lo que usa el modelo predictivo. */
  rations?: number | null;
}

/** Raciones previstas para una comida, por tipo (se configura en Ajustes). */
export interface RationPlan {
  /** Hidratos que no provienen de la fruta (cereales, pasta, pan, legumbres, patata…). */
  harinas?: number | null;
  verduras?: number | null;
  fruta?: number | null;
}

export interface Meal {
  injectionId: string;
  name: string; // copia del nombre en el momento del registro
  kind: InjectionKind;
  optional?: boolean;
  before: MealReading;
  foodTime: string; // hora a la que va a comer
  items: FoodEntry[];
  after: Reading; // al terminar de comer
}

/** Medición parcial entre dos registros principales. */
export interface ExtraReading extends Reading {
  id: string;
  afterInjectionId: string; // tras qué administración se sitúa
  source: MeasureSource;
  /** Incidencias u observaciones de esta medición. */
  note?: string;
  /** Raciones adicionales tomadas en este momento (para el modelo predictivo). */
  extraRations?: number | null;
}

export interface Activity {
  id: string;
  start: string;
  end: string;
  type: string;
  before: Reading; // la hora no se usa: el intervalo ya la define
  after: Reading;
  supplemented: boolean;
  supplementDetail: string;
  incident: string;
}

export interface DayRecord {
  date: string; // YYYY-MM-DD
  meals: Meal[];
  extras: ExtraReading[];
  activities: Activity[];
}

export interface InjectionDef {
  id: string;
  name: string;
  kind: InjectionKind;
  maxUnits: number;
  /** Unidades que se proponen por defecto al registrar esta administración (se pueden cambiar en cada comida). */
  defaultUnits?: number | null;
  /** Raciones previstas en esta comida (harinas, verduras, fruta); se muestran como leyenda en el registro. */
  plan?: RationPlan;
  /** Comida opcional (p. ej. media mañana): no cuenta como "pendiente" si está vacía. */
  optional?: boolean;
}

/** Parámetros del modelo predictivo (valores típicos de análogo rápido; editables). */
export interface PredictModel {
  diaMin: number; // duración de la acción de la insulina rápida (min)
  peakMin: number; // pico de acción (min)
  carbMin: number; // duración de la absorción de hidratos (min)
  carbMinFat: number; // ídem si la comida lleva grasas/proteínas
}

export interface Settings {
  injections: InjectionDef[];
  doseStep: number; // 0.5 = enteras y medias unidades
  gramsPerRation: number; // gramos de hidratos por ración
  unitsPerRation: number; // unidades de rápida por ración
  /** Versión del esquema de ajustes (para migraciones). */
  version?: number;
  dailyCalories?: number | null;
  /** % de las calorías diarias que aportan los hidratos (orientativo). */
  carbPercent?: number;
  /** Insulina diaria total (para calcular el factor de sensibilidad). */
  dailyRapid?: number | null;
  dailyLenta?: number | null;
  /** Factor de sensibilidad: mg/dL que baja 1 U de rápida. */
  isf?: number | null;
  /** Glucemia objetivo para correcciones. */
  targetGlucose?: number;
  model?: PredictModel;
}

export interface Food {
  id: string;
  name: string;
  group: string;
  carbsPer100g: number;
}

export interface DayMark {
  hasData: boolean;
  worst: 'hipo' | 'hiper' | null;
}

export const ARROWS: ReadonlyArray<{ key: Arrow; label: string; deg: number }> = [
  { key: 'up', label: 'Subiendo rápido (flecha vertical hacia arriba)', deg: -90 },
  { key: 'upRight', label: 'Subiendo (diagonal hacia arriba)', deg: -45 },
  { key: 'flat', label: 'Estable (flecha horizontal)', deg: 0 },
  { key: 'downRight', label: 'Bajando (diagonal hacia abajo)', deg: 45 },
  { key: 'down', label: 'Bajando rápido (flecha vertical hacia abajo)', deg: 90 },
];

export type Role = 'admin' | 'user';

/** Documento de la sección de documentación (Markdown). */
export interface DocItem {
  slug: string;
  title: string;
  markdown: string;
  updatedAt: number;
  updatedBy: string;
}

/** Aviso entre cuidadores que comparten niño. */
export interface AlertItem {
  id: string;
  kind: 'hipo' | 'hiper';
  value: number;
  arrow: Arrow | null;
  time: string; // hora de la medición HH:mm
  date: string; // día del registro
  byUid: string;
  byName: string;
  at: number; // marca de tiempo (ms)
}

/** Perfil guardado en Firestore: users/{uid}. El rol solo lo puede cambiar un administrador. */
export interface UserProfile {
  uid: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  /**
   * Espacio de datos que usa esta cuenta. Si está vacío, el suyo propio.
   * Varias cuentas (padre, madre, abuela…) pueden apuntar al mismo niño.
   */
  dataUid?: string;
}

/** Invitación para que una persona cree su propia cuenta y comparta los datos de un niño (colección `invites`). */
export interface InviteItem {
  /** Código secreto, también es el id del documento y va en el enlace. */
  code: string;
  /** Espacio de datos (niño) al que dará acceso. */
  dataUid: string;
  spaceName: string;
  label: string;
  createdByName: string;
  createdAt: number;
  expiresAt: number;
}
