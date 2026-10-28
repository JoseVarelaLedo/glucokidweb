# Avisos push con la aplicación cerrada (plan gratuito)

Cuando alguien guarda una hipoglucemia (<70) o hiperglucemia (>350), la app llama a una función de Netlify
(`netlify/functions/notify.mjs`), que comprueba quién es, y envía una notificación (Firebase Cloud Messaging)
a los móviles de los **demás** cuidadores de ese niño, aunque tengan la app cerrada.
Todo cabe en los planes gratuitos: Firebase Spark (FCM no tiene coste) y Netlify (125.000 llamadas/mes en funciones).

Sin esta configuración la app sigue funcionando igual, con los avisos «con la app abierta».

## 1. Clave pública (VAPID) — en la consola de Firebase
1. Consola de Firebase → ⚙ **Configuración del proyecto** → pestaña **Cloud Messaging**.
2. En **Certificados push web** pulsa **Generar par de claves**.
3. Copia la clave (la pública, empieza por `B…`; no es secreta) en uno de estos dos sitios:
   - **En tu equipo**: `src/app/core/push.config.ts` (cópialo de `push.config.example.ts`): `export const vapidKey = 'B…';`
   - **En Netlify** (el fichero no está en Git): variable de entorno `FIREBASE_VAPID_KEY` con esa clave.
     `scripts/write-config.mjs` genera `push.config.ts` con ella al construir. No la marques como secreta.
4. En esa misma pestaña comprueba que **API de Firebase Cloud Messaging (V1)** está *Habilitada*.

## 2. Clave del servidor (SECRETA) — solo en Netlify
1. Consola de Firebase → ⚙ Configuración del proyecto → **Cuentas de servicio** → **Generar nueva clave privada**.
   Se descarga un `.json`. **No lo subas a ningún repositorio ni lo pegues en el código.**
2. Netlify → tu sitio → *Site configuration* → **Environment variables** → *Add a variable*:
   - Nombre: `FIREBASE_SERVICE_ACCOUNT`
   - Valor: el contenido completo del `.json` (se admite también en base64).
   - Alcance: *Functions* (y *Builds* si te lo pide).
   - Si Netlify rechazase el tamaño, usa tres variables: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`
     y `FIREBASE_PRIVATE_KEY` (la clave tal cual, con los `\n`).
3. Borra el `.json` de tu equipo cuando lo hayas pegado (puedes generar otro cuando lo necesites).

## 3. Desplegar (importante)
Las funciones solo se publican si Netlify construye el proyecto: **arrastrar la carpeta `dist` no las incluye**.
Dos opciones:
- **Git** (ver `GITHUB-NETLIFY.md`): sube el proyecto a un repositorio privado de GitHub y enlázalo en Netlify. Cada `push` despliega todo.
  `firebase.config.ts` y `push.config.ts` no están en el repositorio: Netlify los genera con las variables de entorno
  (`FIREBASE_*`, incluida `FIREBASE_VAPID_KEY`). El `.json` del paso 2 NO debe ir nunca al repositorio.
- **CLI**: `npx netlify-cli login`, `npx netlify-cli link` y `npx netlify-cli deploy --build --prod`.

## 4. Activar en cada móvil
En la app: **Ajustes → Avisos entre cuidadores → «Recibir avisos aunque la aplicación esté cerrada»** y aceptar el permiso.
- **Android/Chrome**: funciona directamente (mejor si instalas la web: menú → «Instalar aplicación»).
- **iPhone/iPad (iOS 16.4 o posterior)**: primero *Compartir → Añadir a pantalla de inicio*, abrir desde ese icono y activar.
- Al **cerrar sesión**, ese dispositivo se da de baja. Quien registra la medición no recibe su propio aviso.

## Cómo comprobar que funciona
1. Activa los avisos en dos móviles con cuentas distintas que compartan niño; cierra la app en uno.
2. Desde el otro registra una medición de prueba <70 (y bórrala después).
3. Si no llega: Netlify → *Functions* → `notify` → registros (error 503 = falta la variable; 403 = la cuenta no
   comparte ese niño; 401 = sesión caducada). Comprueba también los permisos de notificaciones del móvil
   y el ahorro de batería (en algunos Android hay que permitir la app «sin restricciones»).

## Límites que conviene conocer
- Es una ayuda complementaria, **no un sistema de alarma médica**: dependen de la cobertura, del modo
  «No molestar» y del ahorro de batería del móvil. No sustituye a las alarmas del monitor de glucosa.
- El aviso lleva solo el valor, la hora y el nombre de quien lo registró.
- Los avisos se envían cuando una medición se **guarda** con conexión; offline se enviarán cuando haya red solo si la app sigue abierta.
