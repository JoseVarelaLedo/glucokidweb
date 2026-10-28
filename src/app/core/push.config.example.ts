/**
 * PLANTILLA de push.config.ts (este fichero SÍ se sube al repositorio; push.config.ts, no).
 * Copia este fichero como push.config.ts y pon tu clave VAPID, o deja que scripts/write-config.mjs
 * lo genere desde la variable FIREBASE_VAPID_KEY.
 *
 * Avisos push con la app cerrada (ver PUSH.md).
 *
 * `vapidKey` es la clave PÚBLICA de "Certificados push web" (Consola de Firebase → Configuración del
 * proyecto → Cloud Messaging). No es secreta. Mientras esté vacía, los avisos solo llegan con la app abierta.
 */
export const vapidKey = '';

/** Función de Netlify que envía los avisos (carpeta netlify/functions). */
export const pushEndpoint = '/.netlify/functions/notify';
