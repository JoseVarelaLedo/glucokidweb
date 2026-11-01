// Lógica del envío de avisos push, sin dependencias de Firebase (se inyectan), para poder probarla.
//
// Flujo: un cuidador guarda una hipo/hiper → la app llama a esta función con su sesión (ID token) →
// comprobamos quién es y que puede usar ese espacio → enviamos una notificación a los dispositivos
// registrados de los DEMÁS cuidadores de ese niño.

const RE_ID = /^[A-Za-z0-9_:.-]{1,200}$/;
const RE_SPACE = /^[A-Za-z0-9_-]{1,128}$/;
const RE_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
const recent = new Map(); // id → instante (evita reenvíos repetidos en la misma instancia)

export function clean(body) {
  const a = body && body.alert;
  const space = body && body.space;
  if (typeof space !== 'string' || !RE_SPACE.test(space)) return null;
  if (!a || typeof a !== 'object') return null;
  if (typeof a.id !== 'string' || !RE_ID.test(a.id)) return null;
  if (a.kind !== 'hipo' && a.kind !== 'hiper') return null;
  if (typeof a.value !== 'number' || !Number.isFinite(a.value) || a.value < 10 || a.value > 700) return null;
  if (typeof a.time !== 'string' || !RE_TIME.test(a.time)) return null;
  if (typeof a.date !== 'string' || !RE_DATE.test(a.date)) return null;
  return { space, alert: { id: a.id, kind: a.kind, value: Math.round(a.value), time: a.time, date: a.date } };
}

/**
 * deps: verifyIdToken(token) → {uid} | lanza · getProfile(uid) → perfil | null ·
 *       listDevices(space) → [{id, token, uid}] · send(tokens, data) → [{ok, code}] · removeDevices(space, ids)
 */
export async function handleNotify({ method, authorization, body }, deps, now = Date.now()) {
  if (method !== 'POST') return { status: 405, json: { error: 'method' } };
  const m = /^Bearer (.+)$/.exec(authorization || '');
  if (!m) return { status: 401, json: { error: 'auth' } };

  let uid;
  try {
    uid = (await deps.verifyIdToken(m[1])).uid;
  } catch {
    return { status: 401, json: { error: 'auth' } };
  }

  const v = clean(body);
  if (!v) return { status: 400, json: { error: 'bad-request' } };

  const profile = await deps.getProfile(uid);
  if (!profile || profile.active === false) return { status: 403, json: { error: 'forbidden' } };
  const kids = Array.isArray(profile.dataUids) ? profile.dataUids : [];
  const allowed = v.space === uid || (profile.dataUid || '') === v.space || kids.includes(v.space) || profile.role === 'admin';
  if (!allowed) return { status: 403, json: { error: 'forbidden' } };

  for (const [k, t] of recent) if (now - t > 10 * 60 * 1000) recent.delete(k);
  const key = v.space + '|' + v.alert.id;
  if (recent.has(key)) return { status: 200, json: { sent: 0, duplicate: true } };
  recent.set(key, now);

  const devices = (await deps.listDevices(v.space)).filter((d) => d && typeof d.token === 'string' && d.uid !== uid);
  const seen = new Set();
  const targets = devices.filter((d) => (seen.has(d.token) ? false : (seen.add(d.token), true)));
  if (!targets.length) return { status: 200, json: { sent: 0 } };

  const what = v.alert.kind === 'hipo' ? 'hipoglucemia' : 'hiperglucemia';
  const who = String(profile.name || 'Alguien').slice(0, 60);
  // Nombre del niño: quien cuida de varios niños necesita saber de cuál es el aviso
  const space = v.space === uid ? profile : await deps.getProfile(v.space).catch(() => null);
  // «nombre del niño»; si falta, el de la cuenta salvo que sea administrador (una persona, no el niño)
  const kid = String((space && (space.kidName || (space.role === 'admin' ? '' : space.name))) || '').trim().slice(0, 60);
  const data = {
    id: v.alert.id,
    kind: v.alert.kind,
    title: (v.alert.kind === 'hipo' ? '⚠ Hipoglucemia' : '⚠ Hiperglucemia') + (kid ? ` de ${kid}` : ' registrada'),
    body: `${who} ha registrado ${v.alert.value} mg/dL${kid ? ` de ${kid}` : ''} (${what}) a las ${v.alert.time}.`,
  };

  const results = await deps.send(targets.map((d) => d.token), data);
  const dead = targets.filter((_, i) => results[i] && !results[i].ok && DEAD.has(results[i].code)).map((d) => d.id);
  if (dead.length) await deps.removeDevices(v.space, dead).catch(() => undefined);
  return { status: 200, json: { sent: results.filter((r) => r && r.ok).length, removed: dead.length } };
}
