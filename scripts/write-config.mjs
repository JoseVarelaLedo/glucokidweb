// Genera src/app/core/firebase.config.ts y src/app/core/push.config.ts a partir de variables de entorno
// cuando esos ficheros NO existen (p. ej. en Netlify, donde no están en el repositorio).
//
//  - Si el fichero ya existe, NO se toca (en tu equipo sigues usando el tuyo).
//  - Se parte de las plantillas *.example.ts, que son la referencia de la estructura.
//  - En Netlify, si faltan los datos obligatorios, el despliegue FALLA con un mensaje claro
//    (mejor que publicar una app que, sin avisar, funcione solo en modo local).
//  - En local, si faltan, se crea una configuración vacía (la app arranca en modo local) y se avisa.
//
// Variables (todas públicas, no son secretos; ver PUSH.md y GITHUB-NETLIFY.md):
//   FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, FIREBASE_STORAGE_BUCKET,
//   FIREBASE_MESSAGING_SENDER_ID, FIREBASE_APP_ID      → firebase.config.ts (API_KEY y PROJECT_ID obligatorias)
//   FIREBASE_VAPID_KEY                                  → push.config.ts (opcional: sin ella no hay avisos push)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(root, 'src', 'app', 'core');
const env = process.env;
const onNetlify = env.NETLIFY === 'true';

const q = (v) => "'" + String(v).trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]/g, '') + "'";

/** Sustituye `clave: ''` por el valor de la variable de entorno, conservando el resto de la plantilla. */
function fill(template, pairs) {
  let out = template;
  for (const [pattern, value] of pairs) {
    if (value === undefined || String(value).trim() === '') continue;
    const re = new RegExp(pattern);
    if (!re.test(out)) throw new Error('La plantilla no contiene ' + pattern);
    out = out.replace(re, (_m, pre) => pre + q(value));
  }
  return out;
}

function generate(name, pairs, required) {
  const target = join(core, name + '.ts');
  if (existsSync(target)) {
    console.log(`[config] ${name}.ts ya existe: se usa tal cual.`);
    return;
  }
  const example = join(core, name + '.example.ts');
  if (!existsSync(example)) {
    console.error(`[config] Falta la plantilla ${name}.example.ts`);
    process.exit(1);
  }
  const missing = required.filter((k) => !String(env[k] ?? '').trim());
  if (missing.length && onNetlify) {
    console.error(
      `\n[config] ERROR: ${name}.ts no existe y faltan variables de entorno en Netlify: ${missing.join(', ')}.\n` +
        `         Añádelas en Netlify → Project configuration → Environment variables (ver GITHUB-NETLIFY.md) y vuelve a desplegar.\n`,
    );
    process.exit(1);
  }
  writeFileSync(target, fill(readFileSync(example, 'utf8'), pairs));
  const used = pairs.some(([, v]) => String(v ?? '').trim() !== '');
  if (!used) {
    console.log(`[config] ${name}.ts creado con valores vacíos (sin variables de entorno).`);
  } else if (missing.length) {
    console.warn(`[config] Aviso: ${name}.ts creado VACÍO (faltan ${missing.join(', ')}). La app funcionará en modo local.`);
  } else {
    console.log(`[config] ${name}.ts generado desde variables de entorno.`);
  }
}

generate(
  'firebase.config',
  [
    ["(apiKey:\\s*)'[^']*'", env.FIREBASE_API_KEY],
    ["(authDomain:\\s*)'[^']*'", env.FIREBASE_AUTH_DOMAIN],
    ["(projectId:\\s*)'[^']*'", env.FIREBASE_PROJECT_ID],
    ["(storageBucket:\\s*)'[^']*'", env.FIREBASE_STORAGE_BUCKET],
    ["(messagingSenderId:\\s*)'[^']*'", env.FIREBASE_MESSAGING_SENDER_ID],
    ["(appId:\\s*)'[^']*'", env.FIREBASE_APP_ID],
  ],
  ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID'],
);

generate('push.config', [["(export const vapidKey = )'[^']*'", env.FIREBASE_VAPID_KEY]], []);
