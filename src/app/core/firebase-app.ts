import type { FirebaseApp } from 'firebase/app';
import type { Firestore } from 'firebase/firestore';
import { firebaseConfig } from './firebase.config';

let appPromise: Promise<FirebaseApp> | undefined;
let dbPromise: Promise<Firestore> | undefined;

/** Carga Firebase bajo demanda para que no pese en el arranque del modo local. */
export function getFirebaseApp(): Promise<FirebaseApp> {
  appPromise ??= import('firebase/app').then((m) => (m.getApps().length ? m.getApp() : m.initializeApp(firebaseConfig)));
  return appPromise;
}

/** Instancia única de Firestore (con caché offline) compartida por toda la app. */
export function getDb(): Promise<Firestore> {
  dbPromise ??= (async () => {
    const app = await getFirebaseApp();
    const fs = await import('firebase/firestore');
    try {
      return fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
      });
    } catch {
      return fs.getFirestore(app);
    }
  })();
  return dbPromise;
}

/** Al cerrar sesión borramos la caché local para no dejar datos en dispositivos compartidos. */
export async function wipeLocalCache(): Promise<void> {
  try {
    const db = await getDb();
    const fs = await import('firebase/firestore');
    await fs.terminate(db);
    await fs.clearIndexedDbPersistence(db);
  } catch {
    /* mejor esfuerzo */
  }
}
