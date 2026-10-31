# GlucoKid

Registro de glucemias, comidas y actividad física + calculadora de raciones e insulina rápida.
Angular 20 · multiusuario con roles · móvil primero (con interruptor "Vista PC") · datos en Firebase (Firestore) · alojado en Netlify.
La documentación se muestra para el despliegue en **Netlify**, para futuras evoluciones, de ser el caso, en la aplicación, se estudiaría un escalado a un hosting dimensionado a las necesidades que surjan.

## Probar en local

```bash
npm install
npm start          # http://localhost:4200
o en su defecto
ng serve
```

Sin configurar Firebase funciona en **modo local**: los datos se guardan solo en el navegador del dispositivo.


## Activar Firebase (datos sincronizados, varios usuarios y roles)
1. [console.firebase.google.com](https://console.firebase.google.com) → crear proyecto.
2. **Firestore Database** → crear base de datos (región europea, p. ej. `eur3`).
3. **Authentication** → método *Correo/contraseña* → activar.
4. Configuración del proyecto → *Tus apps* → Web → copiar la configuración en `src/app/core/firebase.config.ts`
   (cópiala de la plantilla `firebase.config.example.ts`; ver «Configuración propia y repositorio»).
5. Firestore → *Reglas*: pegar el contenido de `firestore.rules` y publicar.
6. **Crear el primer administrador (una sola vez, a mano):**
   - Authentication → *Users* → *Add user* (tu correo y contraseña). Copia su **UID**.
   - Firestore → *Iniciar colección* `users` → ID de documento = ese **UID** → campos:
     `email` (string), `name` (string), `role` = `admin` (string), `active` = `true` (boolean).
7. Entra en la app con esa cuenta: en **Usuarios** puedes crear el resto (un usuario por niño, o los que queráis) y ver los datos de cualquiera con el selector «Niño».

### Seguridad
- Las contraseñas las gestiona Firebase Authentication (guardadas con hash, nunca en claro).
- Firestore cifra los datos en tránsito (HTTPS) y en reposo.
- Cada usuario solo lee y escribe `users/{su uid}/…` (sus días, su catálogo de alimentos y sus ajustes); los administradores acceden a todos. Esto lo imponen las **reglas de Firestore en el servidor**, no la interfaz.
- Un usuario no puede cambiar su propio rol (solo los administradores escriben en `users/{uid}`).
- Al cerrar sesión se borra la caché local del navegador.
- Los administradores no ven las contraseñas de nadie; pueden enviar un correo de restablecimiento.

## Configuración propia y repositorio
Dos ficheros contienen la configuración de **tu** proyecto y **no se suben a Git** (están en `.gitignore`):

| Fichero | Contiene | Plantilla (sí se sube) |
|---|---|---|
| `src/app/core/firebase.config.ts` | configuración web de Firebase (`apiKey`, `projectId`…) | `firebase.config.example.ts` |
| `src/app/core/push.config.ts` | clave pública VAPID de los avisos push | `push.config.example.ts` |

No son secretos (la seguridad la dan el inicio de sesión y las reglas de Firestore), pero identifican tu proyecto.
Hay dos formas de tenerlos:
- **En tu equipo**: copia cada `*.example.ts` quitando `.example` y rellena los valores.
- **Generados automáticamente**: `scripts/write-config.mjs` (se ejecuta solo antes de `npm start` y `npm run build`) los crea desde
  variables de entorno **solo si no existen**. Así funciona Netlify. Variables: `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`,
  `FIREBASE_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, `FIREBASE_APP_ID` y, para los avisos push,
  `FIREBASE_VAPID_KEY`. En Netlify, si faltan `FIREBASE_API_KEY` o `FIREBASE_PROJECT_ID`, el despliegue falla con un mensaje claro.
  En local, si faltan, se crea una configuración vacía y la app arranca en modo local.

Lo que **nunca** debe subirse: el `.json` de la cuenta de servicio de Firebase (solo en la variable `FIREBASE_SERVICE_ACCOUNT`
de Netlify), ficheros `.env` y las copias de seguridad descargadas desde Ajustes (datos de salud). El repositorio puede ser **público** (incluido `firestore.rules`, que no contiene secretos) siempre que no se suba ninguno de esos ficheros ni datos de salud;
si tienes dudas, hazlo **privado**.

## Desplegar en Netlify
- **Con GitHub (recomendado)**: sigue `GITHUB-NETLIFY.md` (subir el repositorio, enlazarlo con Netlify, variables de entorno y dominio autorizado en Firebase).
  `netlify.toml` ya define el build `npm run build`, la carpeta `dist/glucokid/browser`, la redirección SPA y la función de avisos.
- Sin Git: `npm run build` y arrastrar la carpeta `dist/glucokid/browser` a Netlify Drop (añade también un fichero `_redirects` con
  `/* /index.html 200`). **Así no se publican las funciones**, por lo que no habrá avisos push.
- En Firebase → Authentication → *Settings → Authorized domains*, añadir el dominio de Netlify.

## Estructura
- `core/glucose.ts` reglas de clasificación (hipo, tendencias, estable, hiper).
- `core/dose.ts` cálculo de dosis (preparado para añadir factores de corrección como `DoseAdjustment`).
- `core/predict.ts` modelo predictivo (insulina activa, absorción de hidratos a partir de raciones, desviaciones, patrones).
- `core/evolution.ts` estadísticas y tendencia por semana, mes y año.
- `core/calibration.ts` y `core/calibration.service.ts` fiabilidad del monitor frente a las glucemias capilares.
- `core/foods-io.ts` importación y exportación del catálogo de alimentos en JSON.
- `core/stores.ts` almacenamiento local y Firestore (`days/{fecha}`, `config/settings`, `config/foods`).
- `core/util.ts` utilidades de fechas; aquí está `CLOSE_GRACE_HOURS` (margen de cierre de los días).
- `shared/` componentes reutilizables: selector de alimentos (`food-picker`), instantánea de un día cerrado (`day-snapshot`),
  curva del día (`day-curve`, `glucose-chart`), evolución (`evolution`) y fiabilidad del monitor (`monitor-panel`, `monitor-hint`).
- `pages/` registro, calculadora, alimentos, docs, usuarios, ajustes.
- `scripts/write-config.mjs` genera los ficheros de configuración propios desde variables de entorno.
- `netlify/functions/` función que envía los avisos push.

## Novedades de esta versión
- **Media mañana** opcional entre desayuno y comida; las mediciones posteriores a la insulina lenta desaparecen
  (las intermedias son «Mediciones post desayuno/comida/…» y admiten nota y raciones adicionales).
- **Ajustes**: calorías diarias (% de hidratos), insulina diaria rápida/lenta y cálculo del factor de sensibilidad
  (constante única 1700 ÷ insulina diaria total), unidades por defecto de cada administración, glucemia objetivo (150 por defecto) y parámetros del modelo.
- **Calculadora**: pestaña «Corrección por hiperglucemia»: (glucemia − objetivo) ÷ factor, redondeado a enteros.
- **Curva del día** (botón al final del registro): glucemia medida y prevista con insulina y raciones previas,
  desviaciones y recomendaciones por comida, y búsqueda de patrones en 14 días. Es solo informativo.
- **Cuentas compartidas**: varias cuentas usan los datos de un mismo niño (`dataUid` en `users/{uid}`, desde *Usuarios*).
  Las personas se dan de alta **por invitación**: el administrador genera un enlace de un solo uso (`/unirse/<código>`) y la persona
  crea su propia cuenta. Guía en `COMPARTIR-NINO.md`. Requiere publicar las reglas de `firestore.rules`.
- **Avisos**: si alguien guarda una hipoglucemia (<70) o hiperglucemia (>350), el resto lo ve al instante
  (banner, sonido, vibración, notificación) si tiene la app abierta. **Con la app cerrada**, notificaciones push
  (Firebase Cloud Messaging + función de Netlify), también en el plan gratuito: configúralo con `PUSH.md`.
- **Docs**: sube ficheros Markdown; cada uno tiene su URL (`/docs/<nombre>`); enlaces, correos y teléfonos son
  pulsables. Hace falta iniciar sesión (los datos son del niño). Se sanea el contenido (sin scripts ni imágenes).
- Al actualizar desde la versión anterior, lee `MIGRACION.md` (qué respaldar y qué reglas publicar).

## Novedades desde la v2.0.0

### Raciones
- **Raciones previstas por comida** (harinas, verduras, fruta) configurables en *Ajustes*; se muestran como leyenda en el registro y en la calculadora.
- En el registro, cada alimento se anota en **raciones** (con medias raciones); el modelo predictivo parte de ellas para calcular la desviación
  y las propuestas de corrección. Los registros antiguos con texto libre («200 g») siguen contando mediante el catálogo.
- **Gramos por ración de cada alimento** (*Alimentos*): una ración son los gramos de hidratos de *Ajustes* (10 g por defecto). Lo que se guarda
  sigue siendo «hidratos por 100 g»; los gramos por ración se derivan de ahí y se recalculan en ambos sentidos.

### Días pasados cerrados
- Un día anterior se abre como **instantánea de solo lectura**: mediciones, comidas y raciones, insulina, mediciones post-comida con sus notas,
  actividad con incidencias y curva de glucemia.
- Hay un margen tras la medianoche (3 h por defecto) para completar la última medición; se cambia con `CLOSE_GRACE_HOURS` en `core/util.ts`
  (0 = cierre a las 00:00).
- Solo los administradores (o el modo local) pueden reabrir un día («Editar de todos modos» / «Volver a bloquear»).
- El bloqueo es **de la interfaz**: las reglas de Firestore no lo imponen.

### Selector de alimentos
- En ordenador, desplegable con **búsqueda** (sin distinguir acentos, con teclado y ratón, agrupado por tipo de alimento).
- En móviles y tabletas (puntero táctil) se usa el **selector nativo** del sistema, agrupado, con la opción «Otro alimento (escribir)…» en el registro.

### Evolución por semana, mes y año
- En *Registro* hay pestañas **Día · Semana · Mes · Año · Monitor**. Semana (lunes a domingo), mes y año naturales, con navegación entre periodos.
- Resumen de **tendencia** frente al periodo anterior (mejora, empeora o estable según el % de mediciones en rango, con avisos sobre hipoglucemias,
  variabilidad y cambio de la media), indicadores (mediciones, media, % en rango, hipoglucemias, variabilidad, insulina rápida y lenta diaria),
  gráficas (glucemia media y mínimo–máximo, reparto por zonas e insulina rápida) y tablas.
- Solo es informativo: las mediciones son puntuales, no un monitor continuo. La vista de año lee los registros de dos años (unos 700 documentos).

### Alimentos en JSON
- *Alimentos → Importar o exportar (JSON)*. El archivo lleva, de cada alimento, `name`, `group`, `gramsPerRation` (gramos del alimento que aportan
  una ración) y `carbsPer100g`; basta con uno de los dos últimos. Si vienen los dos y no coinciden, manda `carbsPer100g`.
- La importación **valida y muestra una vista previa** (nuevos, actualizados, sin cambios y entradas descartadas con el motivo) antes de aplicar, y puede
  *añadir y actualizar* o *reemplazar todo* (con confirmación). Se limita a 1 MB y 2000 alimentos.
```json
{
  "app": "glucokid-alimentos",
  "version": 1,
  "carbsPerRation": 10,
  "foods": [
    { "name": "Pasta cocida", "group": "Cereales, pasta y pan", "gramsPerRation": 40, "carbsPer100g": 25 }
  ]
}
```
- La copia de seguridad completa (días, ajustes, alimentos y docs) sigue en *Ajustes → Copia de seguridad*.

### Fiabilidad del monitor frente al capilar
- Pestaña **Monitor** del registro. Cada capilar con una lectura del monitor a menos de 10 minutos forma un **par**; de los pares se aprende, con
  estadística robusta y prudente, cuánto y en qué condiciones difiere el monitor del capilar (nivel de glucemia, flecha de tendencia y **día de vida del sensor**).
- **Cambio de sensor**: se anota la fecha en la pestaña Monitor (se guarda en `settings.sensors`); el registro muestra «sensor día N».
- El aprendizaje se **valida con datos que aún no había visto** (comprobación «hacia delante»). Solo cuando mejora de verdad el error del monitor
  (con al menos 50 pares y 20 comprobaciones) aparecen **avisos bajo las lecturas del monitor**; antes, la pestaña solo muestra el progreso.
  Si el monitor y el capilar no difieren de forma predecible, lo dice y no avisa. Es preferible tardar meses a avisar con pocos datos.
- El modelo predictivo **no se usa para corregir** el monitor: solo se contrasta con el capilar para comparar su error.
- Los parámetros (pares mínimos, ventana de 180 días, separación máxima…) están al principio de `core/calibration.ts`.
- Es informativo: no sustituye al capilar ni a la valoración del equipo médico, y nunca modifica ni oculta un aviso de hipoglucemia del monitor.

## Aviso
Los valores de hidratos precargados son orientativos y editables; contrastadlos con la tabla de vuestro equipo de endocrinología. La app es una ayuda, no sustituye su criterio.
