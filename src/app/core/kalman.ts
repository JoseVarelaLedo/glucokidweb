/**
 * Filtro de Kalman del ERROR de la previsión.
 *
 * Se parte de la previsión del modelo, G_modelo(t), y se estima en tiempo real cuánto se aparta la glucemia real de ella:
 *
 *     G_real(t) ≈ G_modelo(t) + e(t)
 *
 * El estado es (e, v): el error en mg/dL y su velocidad en mg/dL/min.
 *  - La velocidad se amortigua rápido (tauV): una tendencia que se ve en el sensor no dura para siempre.
 *  - El error se desvanece despacio hacia 0 (tauE): si el modelo falló por un hidrato mal estimado, el efecto dura horas.
 *  - Cada lectura (sensor o medición anotada) corrige el estado con más o menos peso según su ruido (R). Una lectura que se aparta
 *    muchísimo de lo esperable (compresión del sensor, por ejemplo) pesa menos.
 *  - Sin lecturas, solo crece la incertidumbre: así la previsión futura vuelve poco a poco al modelo.
 * Es informativo; no sustituye al sensor ni a la medición.
 */
export interface KalmanParams {
  tauE: number; // min: constancia del error del modelo
  tauV: number; // min: duración de una tendencia
  qE: number; // mg/dL² por min: ruido del error
  qV: number; // (mg/dL/min)² por min: ruido de la velocidad
  sd0E: number; // mg/dL: incertidumbre inicial del error (la glucemia previa es una medición)
  sd0V: number; // mg/dL/min
  rSensor: number; // mg/dL²: ruido de una lectura del sensor
  rManual: number; // mg/dL²: ruido de una medición anotada
}

export const KALMAN: KalmanParams = { tauE: 240, tauV: 20, qE: 0.5, qV: 0.01, sd0E: 5, sd0V: 0.3, rSensor: 100, rManual: 36 };

export interface KState {
  t: number;
  e: number;
  v: number;
  p11: number;
  p12: number;
  p22: number;
}

export function kInit(t0: number, k: KalmanParams = KALMAN): KState {
  return { t: t0, e: 0, v: 0, p11: k.sd0E ** 2, p12: 0, p22: k.sd0V ** 2 };
}

/** Avanza el estado hasta el minuto t (sin lecturas). */
export function kPredict(s: KState, t: number, k: KalmanParams = KALMAN): KState {
  const dt = t - s.t;
  if (dt <= 0) return s;
  const fe = Math.exp(-dt / k.tauE);
  const fv = Math.exp(-dt / k.tauV);
  const c = k.tauV * (1 - fv);
  const a = fe * s.p11 + c * s.p12; // (F·P)[0][0]
  const b = fe * s.p12 + c * s.p22; // (F·P)[0][1]
  return {
    t,
    e: fe * s.e + c * s.v,
    v: fv * s.v,
    p11: a * fe + b * c + k.qE * dt,
    p12: b * fv,
    p22: fv * fv * s.p22 + k.qV * dt,
  };
}

/** Corrige el estado con una lectura: `resid` = lectura − previsión del modelo en ese minuto; `r` = varianza del ruido de la lectura. */
export function kUpdate(s: KState, resid: number, r: number): KState {
  const y = resid - s.e;
  // lectura muy atípica (más de 3 desviaciones): se le da menos peso
  const rr = Math.max(r, (y * y) / 9 - s.p11);
  const S = s.p11 + rr;
  const k1 = s.p11 / S;
  const k2 = s.p12 / S;
  return {
    t: s.t,
    e: s.e + k1 * y,
    v: s.v + k2 * y,
    p11: (1 - k1) * s.p11,
    p12: (1 - k1) * s.p12,
    p22: s.p22 - k2 * s.p12,
  };
}

/** Desviación típica (mg/dL) del error estimado. */
export const kSd = (s: KState): number => Math.sqrt(Math.max(0, s.p11));
