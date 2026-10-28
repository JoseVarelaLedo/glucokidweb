# Subir GlucoKid a GitHub y desplegarlo en Netlify

Resultado: cada vez que hagas `git push`, Netlify construye y publica la app (y la función de avisos push) automáticamente.
Los ficheros con la configuración de tu proyecto **no** van al repositorio: Netlify los genera con variables de entorno.

> Usa un repositorio **privado**: la app maneja datos de salud de un menor y el repositorio describe tu proyecto de Firebase.

## 0. Antes de empezar
- Cuenta en [GitHub](https://github.com) y en [Netlify](https://app.netlify.com), con [Git](https://git-scm.com/downloads) instalado.
- Ten a mano la configuración web de Firebase (Consola → ⚙ Configuración del proyecto → *Tus apps* → Web).
- Comprueba que el `.gitignore` del proyecto incluye `src/app/core/firebase.config.ts` y `src/app/core/push.config.ts`.

## 1. Crear el repositorio en GitHub
1. GitHub → **New repository**. Nombre (p. ej. `glucokid`), visibilidad **Private**.
2. **No** marques «Add a README», «.gitignore» ni licencia (el proyecto ya los trae). Pulsa **Create repository**.

## 2. Subir el proyecto
En la carpeta del proyecto (la que contiene `package.json`):
```bash
git init
git add .
git status                    # REVISA la lista antes de seguir (ver abajo)
git commit -m "GlucoKid: primera versión"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/glucokid.git
git push -u origin main
```
**Revisa `git status` antes del commit.** No deben aparecer:
`src/app/core/firebase.config.ts`, `src/app/core/push.config.ts`, ningún `.json` de cuenta de servicio, `.env`, copias de seguridad ni `.zip`.
Sí deben aparecer `firebase.config.example.ts`, `push.config.example.ts` y `scripts/write-config.mjs`.
Si algo sensible ya se hubiera añadido: `git rm --cached RUTA` y vuelve a hacer el commit. Si llegó a subirse a GitHub, considera
comprometida esa clave y genera otra (en el caso de la cuenta de servicio, borra la clave en Firebase y crea una nueva).

## 3. Enlazar el repositorio con Netlify
1. Netlify → **Projects** → **Add new project** → **Import an existing project**.
2. Elige **GitHub**. La primera vez te pedirá autorizar la aplicación de Netlify en GitHub: concédele acceso **solo al repositorio
   `glucokid`** («Only select repositories»).
3. Selecciona el repositorio. Netlify lee `netlify.toml`, así que **build command** (`npm run build`) y **publish directory**
   (`dist/glucokid/browser`) ya vienen definidos. No los cambies.
4. **No pulses «Deploy» todavía**: añade antes las variables (paso 4). Si ya lo hiciste, no pasa nada: el primer despliegue fallará
   con un mensaje claro pidiendo las variables y bastará con añadirlas y volver a desplegar.

## 4. Variables de entorno (Project configuration → Environment variables)
Añade cada una con **Add a variable** (alcance: *Builds* y, para la última, también *Functions*). Todas, salvo la última, son públicas:
**no marques «Contains secret values»**.

| Variable | Valor (de la configuración web de Firebase) |
|---|---|
| `FIREBASE_API_KEY` | `apiKey` |
| `FIREBASE_AUTH_DOMAIN` | `authDomain` |
| `FIREBASE_PROJECT_ID` | `projectId` |
| `FIREBASE_STORAGE_BUCKET` | `storageBucket` |
| `FIREBASE_MESSAGING_SENDER_ID` | `messagingSenderId` |
| `FIREBASE_APP_ID` | `appId` |
| `FIREBASE_VAPID_KEY` | clave pública VAPID (solo si usas avisos push; ver `PUSH.md`) |
| `FIREBASE_SERVICE_ACCOUNT` | **SECRETA** (marca «Contains secret values»): contenido del `.json` de la cuenta de servicio (solo para push; ver `PUSH.md`) |

## 5. Primer despliegue
1. **Deploys** → **Trigger deploy** → **Deploy project** (o pulsa Deploy si aún no lo habías hecho).
2. En el registro del build debes ver `[config] firebase.config.ts generado desde variables de entorno.`
3. Abre la URL `https://algo.netlify.app` y entra con tu cuenta.

### Si el build falla con «Secrets scanning found secrets…»
Netlify analiza el código y el resultado del build en busca de posibles secretos y **detiene el despliegue** si encuentra algo que le
parezca uno. La `apiKey` de Firebase y la clave VAPID son públicas por diseño y acaban dentro del JavaScript publicado, así que
pueden saltar como falso positivo. Solución documentada por Netlify: añade la variable
`SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` con los valores seguros separados por comas, por ejemplo `AIza…tu_apiKey…,B…tu_clave_vapid…`,
y vuelve a desplegar. No desactives el escaneo completo: sigue protegiendo `FIREBASE_SERVICE_ACCOUNT`.

## 6. Autorizar el dominio en Firebase
Firebase → Authentication → **Settings** → **Authorized domains** → añade `algo.netlify.app` (y tu dominio propio, si lo usas).
Sin esto, el inicio de sesión falla en la web publicada.

## 7. Día a día
- Cambias código → `git add . && git commit -m "..." && git push` → Netlify despliega solo (1–2 minutos).
- Cada `push` a otra rama crea una vista previa (*Deploy Preview*). Esa vista previa usa otro dominio: si quieres iniciar sesión en
  ella, añade también su dominio en *Authorized domains*, o simplemente trabaja en `main`.
- Si cambias una variable en Netlify, hay que volver a desplegar (**Trigger deploy → Clear cache and deploy project**).
- Reglas de Firestore (`firestore.rules`): se publican a mano en la consola de Firebase; Netlify no las toca.

## 8. Problemas frecuentes
| Síntoma | Causa y solución |
|---|---|
| Build: `faltan variables de entorno en Netlify` | Falta `FIREBASE_API_KEY` o `FIREBASE_PROJECT_ID` (paso 4). |
| La web carga pero guarda «solo en este dispositivo» | Se generó la configuración vacía: revisa las variables y redespliega. |
| `auth/unauthorized-domain` al iniciar sesión | Falta el dominio en *Authorized domains* (paso 6). |
| `Missing or insufficient permissions` | Las reglas de `firestore.rules` no están publicadas o el usuario no tiene perfil en `users`. |
| Avisos push: la función responde 503 | Falta `FIREBASE_SERVICE_ACCOUNT` o no está en el alcance *Functions*. |
| Pantalla en blanco al recargar una ruta | Debe existir la redirección SPA de `netlify.toml` (ya incluida); no la borres. |
