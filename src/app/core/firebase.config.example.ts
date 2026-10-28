/**
 * PLANTILLA de firebase.config.ts (este fichero SÍ se sube al repositorio; firebase.config.ts, no).
 * Copia este fichero como firebase.config.ts y rellena los valores, o deja que
 * scripts/write-config.mjs lo genere desde variables de entorno (ver GITHUB-NETLIFY.md).
 *
 * Configuración web de Firebase (Consola de Firebase → Configuración del proyecto →
 * "Tus apps" → Web). Estos valores NO son secretos: la seguridad la dan el inicio de
 * sesión y las reglas de Firestore (ver firestore.rules y README.md).
 *
 * Mientras `apiKey` y `projectId` estén vacíos, la app funciona en modo local:
 * los datos se guardan solo en el navegador de este dispositivo.
 */
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

export const firebaseEnabled = !!firebaseConfig.apiKey && !!firebaseConfig.projectId;
