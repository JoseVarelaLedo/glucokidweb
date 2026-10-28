// función de Netlify: envía avisos push (Firebase Cloud Messaging) a los demás cuidadores.
// se necesita definir la variable de entorno FIREBASE_SERVICE_ACCOUNT (ver PUSH.md). Si no existe, responde 503
// y la aplicación sigue funcionando con los avisos "con la app abierta".
import { handleNotify } from './notify-core.mjs';

let admin;
async function load() {
  if (admin) return admin;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  let cred = null;
  if (raw) {
    cred = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    cred = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  if (!cred) return null;
  const app = await import('firebase-admin/app');
  const [{ getAuth }, { getFirestore }, { getMessaging }] = await Promise.all([
    import('firebase-admin/auth'),
    import('firebase-admin/firestore'),
    import('firebase-admin/messaging'),
  ]);
  const a = app.getApps().length ? app.getApp() : app.initializeApp({ credential: app.cert(cred) });
  admin = { auth: getAuth(a), db: getFirestore(a), msg: getMessaging(a) };
  return admin;
}

export default async (req) => {
  let a;
  try {
    a = await load();
  } catch (e) {
    console.error('Credenciales de Firebase no válidas:', e && e.message);
    return Response.json({ error: 'config' }, { status: 503 });
  }
  if (!a) return Response.json({ error: 'not-configured' }, { status: 503 });

  let body = null;
  try {
    body = await req.json();
  } catch {
    /* se rechazará como petición incorrecta */
  }

  const deps = {
    verifyIdToken: (t) => a.auth.verifyIdToken(t),
    getProfile: async (uid) => {
      const s = await a.db.doc(`users/${uid}`).get();
      return s.exists ? s.data() : null;
    },
    listDevices: async (space) => {
      const q = await a.db.collection(`users/${space}/devices`).get();
      return q.docs.map((d) => ({ id: d.id, token: d.get('token'), uid: d.get('uid') }));
    },
    send: async (tokens, data) => {
      const out = [];
      for (let i = 0; i < tokens.length; i += 500) {
        const chunk = tokens.slice(i, i + 500);
        const r = await a.msg.sendEachForMulticast({
          tokens: chunk,
          data,
          webpush: { headers: { Urgency: 'high', TTL: '3600' } },
        });
        for (const x of r.responses) out.push({ ok: x.success, code: x.error && x.error.code });
      }
      return out;
    },
    removeDevices: async (space, ids) => {
      await Promise.all(ids.map((id) => a.db.doc(`users/${space}/devices/${id}`).delete()));
    },
  };

  try {
    const r = await handleNotify({ method: req.method, authorization: req.headers.get('authorization'), body }, deps);
    return Response.json(r.json, { status: r.status });
  } catch (e) {
    console.error('Error enviando avisos:', e && e.message);
    return Response.json({ error: 'server' }, { status: 500 });
  }
};
