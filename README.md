# GlucoKid

Registro de glucemias, comidas y actividad física + calculadora de raciones e insulina rápida.
Angular 20 · multiusuario con roles · móvil primero (con interruptor "Vista PC") · datos en Firebase (Firestore) · alojado en Netlify.

## Probar en local

```bash
npm install
npm start          # http://localhost:4200
# o, en su defecto:
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
- `core/food-patterns.ts` alimentos que se repiten con subidas o bajadas de glucemia.
- `core/predictor-eval.ts` (precisión de la previsión y bandas de incertidumbre), `core/agp.ts` (informe: tiempo en rango, GMI, CV, AGP), `core/overnight.ts` (noches y ayunas) y
  `core/analysis.service.ts`; pantallas `shared/report.ts` y `shared/glucose-profile.ts`.
- `core/libre-csv.ts` (lectura del CSV del monitor) y `core/libre-import.ts` (serie por día, unión sin duplicados, estadísticas); `shared/sensor-import.ts` es la pantalla de importación.
- `core/foods-io.ts` importación y exportación del catálogo de alimentos en JSON.
- `core/stores.ts` almacenamiento local y Firestore (`days/{fecha}`, `config/settings`, `config/foods`).
- `core/util.ts` utilidades de fechas; aquí está `CLOSE_GRACE_HOURS` (margen de cierre de los días).
- `shared/` componentes reutilizables: selector de alimentos (`food-picker`), instantánea de un día cerrado (`day-snapshot`),
  curva del día (`day-curve`, `glucose-chart`), evolución (`evolution`) y fiabilidad del monitor (`monitor-panel`, `monitor-hint`).
- `pages/` registro, calculadora, alimentos, docs, usuarios, ajustes.
- Guías: `COMPARTIR-NINO.md` (varias cuentas para un niño), `NUEVO-NINO.md` (añadir un niño y cómo se identifica), `PUSH.md`, `GITHUB-NETLIFY.md`, `MIGRACION.md`.
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

### Varios niños por cuenta

- Una cuenta puede acceder a **varios niños** (p. ej. unos abuelos con varios nietos): **Usuarios → «Niños a los que accede»**. Cada niño se identifica por su
  **nombre de niño** (`kidName`, distinto del nombre de la persona de la cuenta; se edita en *Usuarios*); la cuenta ve un selector **Niño** (o «Datos de Ana» si solo es uno). Los avisos push llegan de todos sus niños e indican de cuál. Ver `NUEVO-NINO.md`.
- Requiere **publicar las reglas de `firestore.rules`** (nuevo campo `dataUids` en el perfil) y volver a desplegar la función de avisos.

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

**Grupos de alimentos actuales** (`FOOD_GROUPS` en `core/defaults.ts`):

- Azúcares y cacaos
- Bebidas
- Cereales, pasta y pan
- Chuches
- Legumbres
- Hortalizas con hidratos
- Fruta
- Frutos secos
- Lácteos
- Postres
- Proteínas y grasas (sin hidratos)
- Repostería
- Salsas
- Verduras verdes (sin hidratos)
- Otros

Al importar, un grupo que no esté en la lista se acepta tal cual; si falta, el alimento va a «Otros». El grupo «Proteínas y grasas (sin hidratos)» se reconoce
por su nombre (alarga la absorción en la curva prevista): si lo renombras, actualiza también `FAT_GROUP` en `core/predict.ts`.

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

### Importar el CSV del sensor

- Pestaña **Monitor → Importar datos del sensor**. Se sube el CSV de glucosa que se descarga de la web del monitor (FreeStyle Libre / LibreView, en español o inglés;
  UTF-8 o Windows-1252; mg/dL o mmol/L). Se puede repetir cada semana: **importar el mismo archivo dos veces no cambia nada**.
- Solo se importa el **historial continuo**. Se guarda como una serie por día (`sensor` dentro del documento del día, pares `[minuto, mg/dL]`) y se dibuja como una
  línea fina en la **curva de glucemia** del día y de las instantáneas de días cerrados, con media, mínimo, máximo y % en rango. **No rellena ni modifica** las mediciones
  anotadas a mano, ni intervienen en dosis o previsiones.
- No se importan escaneos, glucemias de tira, insulina, comidas ni notas. La primera línea del archivo (que lleva el nombre del niño) y el nombre del archivo no se leen,
  no se muestran y no se guardan.
- **Pares automáticos con el capilar**: cada capilar anotado que no tenga una lectura del monitor anotada a mano a menos de 10 minutos se empareja con la serie importada
  (se interpola entre la lectura anterior y la posterior, o se usa la más cercana dentro de ±10 min; si el sensor no tenía datos en esa ventana, no hay par). La **flecha** de esos
  pares es **calculada** con la pendiente de los 15 minutos anteriores (umbrales de 1 y 2 mg/dL por minuto), no la que mostraba la aplicación. En la tabla de la pestaña Monitor se marcan con «csv».
  Cada capilar forma como mucho un par, y se sigue exigiendo la validación con datos nuevos antes de mostrar avisos.
- Los «eventos» del sensor del archivo se ofrecen como posibles cambios de sensor, **sin marcar**: el archivo no indica con certeza qué son.
- **Punto que recorre la curva** (como en LibreLink): al pasar el ratón, o al tocar y arrastrar el dedo, por la gráfica del día aparece una guía vertical con un punto y un recuadro
  con la **hora y el valor** de la lectura del sensor más cercana. Con el teclado: flechas (con Mayús salta 1 h), Inicio, Fin y Escape. Donde el sensor no tiene datos
  (más de 20 min sin lectura) no se muestra ningún valor. Si el día no tiene serie del sensor, recorre las mediciones anotadas.
- En las **mediciones intermedias**, la opción por defecto es ahora **Capilar** y después Monitor.
- Cada día importado ocupa unos pocos KB (hasta 288 lecturas de 5 minutos); no hace falta cambiar las reglas de Firestore.

### Mediciones de madrugada o antes del desayuno

- En *Registro*, encima de la primera comida, el botón **«+ Medición antes del desayuno»** añade una medición previa (capilar por defecto, con hora, glucemia, flecha y nota).
  Se guarda en el día (`afterInjectionId: "pre"`), no cuelga de ninguna administración y sale en la curva, en las estadísticas, en la fiabilidad del monitor y en las instantáneas de días cerrados.

### Flecha opcional y alimentos sin hidratos

- En cada administración solo son obligatorias la **hora**, la **glucemia** y las **unidades**. La **flecha** del monitor es opcional (un capilar no la tiene, y la glucemia
  puede anotarse después leyéndola de la gráfica). Sin flecha, la lectura se clasifica solo por su valor.
- Un alimento **sin hidratos en el catálogo** (0 g por 100 g: brócoli, pollo, aceite…) **no suma raciones**, aunque se anoten. Lo aplican el total «Anotado», la previsión de la curva,
  la comparación con las raciones previstas, las instantáneas y las raciones por día de Evolución. Un alimento que **no está en el catálogo** se cuenta tal como se anota, porque no se puede saber.
  Si le pones hidratos a un alimento en *Alimentos*, vuelve a contar.

### La previsión: qué aprende y límites de seguridad

- La **forma** del modelo es fija (curvas de insulina y de absorción de hidratos con los datos de *Ajustes*), pero la previsión se **contrasta y se corrige con las curvas reales del sensor** de cuatro maneras:
  1. **Filtro de Kalman** (`core/kalman.ts`). Con las lecturas posteriores al ancla (serie del CSV del sensor y mediciones anotadas) se estima, minuto a minuto, cuánto se aparta la realidad de la previsión
     y a qué velocidad cambia esa diferencia. Cada lectura corrige el estado según su ruido (sensor ≈ ±10 mg/dL, medición anotada ≈ ±6; una lectura muy atípica pesa menos) y la parte futura de la curva se corrige con ello:
     la diferencia se desvanece despacio (≈ 4 h) y la tendencia en minutos (≈ 20 min). Sin lecturas, la curva vuelve al modelo. La previsión original se conserva para evaluar el modelo.
  2. **Ajuste con el historial y por franjas del día** (`core/model-fit.ts`). Con al menos **5 comidas con curva del sensor** (hora, dosis y raciones anotadas, sin ejercicio cerca ni hidratos sin dosis) se estiman dos factores:
     uno para el efecto de los hidratos y otro para el de la insulina (mínimos cuadrados, atraídos hacia 1 y limitados a 0,25–1,6, con pesos que reducen el efecto de valores atípicos).
     Después se ajusta **cada franja** (mañana hasta las 11 h, mediodía 11–17 h, tarde y noche desde las 17 h) por separado, atraída hacia el ajuste general, porque la sensibilidad cambia a lo largo del día
     (mínimo 4 comidas por franja). Tanto el ajuste general como el de cada franja **solo se activan si mejoran el error en validación cruzada** (se ajusta sin una comida y se mide en ella), al menos un 3 %.
     Solo vale con los mismos Ajustes con los que se calculó. **No cambia Ajustes ni la calculadora**: solo la curva prevista. Se ve en *Ajustes*, «Ajuste de la previsión con las curvas del sensor».
     Esto corrige el caso típico de una dosis diaria pequeña, en la que 1700 ÷ dosis diaria da un factor de sensibilidad demasiado grande y la previsión se desploma.
  3. **Límites de seguridad** (ver abajo).
  4. **Corrección con inteligencia artificial (opcional, desactivada)**, ver la sección siguiente.
  Aprende también la corrección monitor–capilar (pestaña *Monitor*), que solo se contrasta. Los patrones por alimentos tampoco cambian el cálculo.
  Las desviaciones entre lo medido y lo previsto se muestran para que se revisen los ajustes con el equipo médico, no se aplican solas.
- **Límite de plausibilidad**: si con los datos anotados la previsión pasaría de **400 mg/dL** (`PRED_MAX_PLAUSIBLE` en `core/predict.ts`), no se dibuja. En su lugar se avisa de qué revisar
  (raciones de más, dosis sin anotar o con otra hora, factor de sensibilidad o relación raciones/unidades en Ajustes).
- **Límite por abajo**: si el modelo bajara de **40 mg/dL** (`PRED_MIN_PLAUSIBLE`), tampoco se dibuja ni se avisa con esa cifra: se explica que el factor de sensibilidad o la ratio de Ajustes no encajan.
  Si la previsión de hipoglucemia sale solo de Ajustes (sin lecturas posteriores ni ajuste con el sensor), el aviso pasa de «alerta» a «atención» y se aclara que la cifra puede estar exagerada.
- **Hora de la comida**: el modelo usa la hora de la inyección para la insulina y la de «Hora a la que va a comer» para los hidratos, de modo que la espera entre ambas cuenta (esperar baja el pico y adelanta la bajada).
  Si esa hora está vacía se supone que se come justo al inyectar y, en las comidas con dosis e hidratos, la previsión lo indica con un aviso informativo. Los hidratos que se toman antes de inyectar también cuentan para su comida.
- **Hidratos sin dosis**: si una comida tiene hidratos pero **no hay unidades anotadas** (campo vacío), no se calcula previsión y se pide anotarlas (0 U si de verdad no se puso insulina).
- Es informativo, no es un producto sanitario y no sustituye a la medición ni al equipo médico.

### Corrección con inteligencia artificial (TensorFlow.js, opcional)

- Código: `core/residual-ai.ts` (datos, comprobación y red) y `core/residual-ai.service.ts` (interruptor, entrenamiento y aviso). **Está desactivada por defecto.**
- **Instalación**: `npm install @tensorflow/tfjs-core @tensorflow/tfjs-layers @tensorflow/tfjs-backend-cpu` (y **no** `@tensorflow/tfjs`: éste arrastra `tfjs-data` → `string_decoder` → `safe-buffer`, que necesita el módulo `buffer` de Node y rompe la compilación para el navegador, p. ej. en Netlify).
  Se descarga solo al activar el interruptor (carga diferida), así que no pesa en el arranque de la aplicación.
- **Qué aprende**: el error que aún comete el modelo (con su ajuste por franjas) respecto al sensor del niño, a partir de la hora, la glucemia y flecha iniciales, hidratos, dosis, insulina activa, grasas y la propia previsión.
  Red de 3 capas (12-6-1) entrenada en el dispositivo (CPU); los datos no salen de él. Su efecto se limita a **±40 mg/dL** y es 0 en el ancla.
- **Cuándo se ofrece** (`readiness`): al menos 45 comidas con curva del sensor, 14 días distintos, 450 comparaciones previsto-real, 2 franjas del día con 12 comidas o más, y que el modelo base aún tenga un error medio de 12 mg/dL o más
  (si ya acierta, no hay nada que aprender). Cuando se cumple y está desactivada, aparece un aviso sobre la curva del día y en *Ajustes*; se puede descartar con «Entendido».
- **Cuándo se aplica**: se entrena con las comidas más antiguas y se **valida con el 25 % más reciente**, que no ha visto. Solo se usa si ahí mejora al modelo base un 5 % como mínimo; si no, queda como «no se aplica» y se vuelve a probar al haber más datos.
- **Dónde actúa**: solo en la curva que se enseña en el registro. La evaluación de la previsión, las bandas, el informe y la calculadora **no** la usan (así se siguen midiendo con el modelo base).
- El interruptor se guarda **en este dispositivo y para cada niño** (`localStorage`), no en Firestore.
- Es informativo: no sustituye a la medición ni al equipo médico.

### Alimentos y glucemia (patrones)

- Cálculo en `core/food-patterns.ts`. Para cada comida con alimentos y hora se miran las **4 h siguientes** (sin pasar de la comida siguiente, y sin contar los primeros 30 min)
  y se anota si la glucemia **superó 180** o **bajó de 70** mg/dL. Se usan las mediciones anotadas y, si hay, la serie continua del sensor importada.
- Después se compara cada alimento (y cada grupo de alimentos) con **el resto de las comidas**. Un alimento solo se señala si aparece **al menos 4 veces, en 3 días distintos**,
  con **3 picos como mínimo**, en la mitad o más de sus comidas, y **de forma claramente peor** que el resto (cota inferior de Wilson al 90 %, para no señalar casualidades).
- No se atribuye a la comida una subida si ya había hiperglucemia antes de comer, ni una bajada si ya había hipoglucemia antes o hubo actividad física cerca.
- Aparece en el botón **«Buscar patrones en los últimos 14 días»** (junto a la curva del día) y en la tarjeta **«Alimentos y glucemia»** de Semana, Mes y Año.
  Con pocos días suele no haber suficientes repeticiones: en el mes y el año se ve más.
- Son **pistas, no causas**: influyen la dosis, la cantidad, la hora, el ejercicio y con qué se combina el alimento. Es informativo y no sustituye al equipo médico.

### Previsión medida y bandas de incertidumbre

- Cálculo en `core/predictor-eval.ts`. Para cada comida con curva prevista se compara lo previsto con lo que midió el sensor continuo a los **30, 60… 300 min** (si ese día no hay serie, con las
  mediciones anotadas a ±10 min). La previsión de cada día se recalcula **con los ajustes actuales** y con lo que se anotó de hidratos y dosis (incluidas correcciones posteriores).
- Se muestra en **Registro → Informe → Previsión**: error medio, diferencia media (real − previsto), % de casos a menos de 30 mg/dL y cuánto mejora a suponer que «la glucemia sigue igual»,
  a 1, 2 y 3 h, por comida y por franja horaria. Con menos de 6 comparaciones en una celda se avisa de que hay pocos datos.
- **Banda de incertidumbre**: con los errores pasados (últimos 180 días) se calcula, para cada instante tras la comida, dónde cayó el **80 %** de los casos (cuantiles 10–90 % de real − previsto).
  Se dibuja como franja alrededor de la curva prevista en la gráfica del día. Hacen falta **20 comparaciones a las 2 h**; mientras no las haya se avisa y no se dibuja nada.
  Si a las 2 h la franja mide más de **120 mg/dL** (`BAND_WIDE`) se avisa de que la previsión es poco informativa. Una comprobación hacia delante (la banda de cada día se calcula solo con días anteriores)
  indica qué fracción de lo real cayó dentro; lo ideal es cerca del 80 %.
- Es solo **observación**: no cambia la previsión, la calculadora ni las dosis. La banda es la misma anchura para todas las comidas (depende del instante, no de la comida).

### Informe para la consulta

- **Registro → Informe**, con periodos de 7, 14, 30 y 90 días que terminan en el **último día con lecturas del sensor**. Usa solo la serie continua del CSV; las mediciones manuales no se mezclan.
- Muestra: lecturas y cobertura de datos, glucosa media, **GMI** (3,31 + 0,02392 × media en mg/dL), desviación típica, **CV**, tiempo en cada tramo (&lt;54, 54–69, 70–180, 181–250, &gt;250) frente a los
  objetivos del consenso internacional (70–180 &gt; 70 %, &lt;70 &lt; 4 %, &lt;54 &lt; 1 %, &gt;180 &lt; 25 %, &gt;250 &lt; 5 %, CV ≤ 36 %), hipoglucemias (episodios de ≥ 15 min por debajo de 70, por franja del día),
  el **perfil ambulatorio (AGP)** en tramos de 30 min (mediana, 25–75 % y 5–95 %) y, con más de 7 días, una tabla por semanas.
- Se avisa si hay menos del 70 % de datos del periodo o menos de 14 días. Los objetivos son generales: los de cada niño los marca su equipo médico.
- **Imprimir / guardar PDF** usa la impresión del navegador y saca los tres apartados con el nombre del niño y la fecha, sin menús.
- El informe usa los últimos 180 días ya cargados (una vez por sesión, como la calibración): tras importar un CSV se refresca solo; si se corrige otra cosa, pulsa «Actualizar datos».

### Noche y ayunas

- Cálculo en `core/overnight.ts`. Una **noche valorada** es la ventana de 00:00 a 06:00 (o hasta la primera comida, dosis rápida o ración extra del día) **sin comida ni insulina rápida activa**:
  se descuenta lo que pudiera quedar de la cena (hidratos con grasa: 4 h) y de la última rápida de la tarde anterior (duración de acción de *Ajustes*). Hacen falta **3 h limpias**, el **70 %** de lecturas y
  registro de la tarde anterior y del propio día; si no, la noche aparece en «Noches no valoradas» con el motivo.
- Por noche: valor al inicio y al final (medianas de 3 lecturas), mínimo, máximo y si hubo hipoglucemia. **Ayunas**: valor justo antes de la primera comida o dosis de la mañana, con ≥ 3 h sin comer.
- Solo se habla de **patrón** con al menos **5 noches**: subida o bajada de ≥ 30 mg/dL en el 60 % o más de las noches, o hipoglucemias nocturnas en ≥ 2 noches (o ≥ 15 %). Una bajada de 54 mg/dL se avisa siempre.
- Son **observaciones para comentar con el equipo médico**: la aplicación no sugiere cambiar ninguna dosis (ni de lenta ni de rápida).

### Relación unidades/ración observada (Ajustes)

- Cálculo en `core/ratio-observed.ts`. Con lo anotado en los **últimos 30 días** se divide, en cada comida de rápida con unidades y raciones, unidades ÷ raciones y se toma la **mediana por comida**
  (y el total: unidades ÷ raciones de todas las comidas). Se cuentan solo raciones con hidratos (el brócoli y similares no suman) y se necesitan **5 comidas** por fila.
- Se dejan fuera las comidas con **glucemia previa por encima de 180 mg/dL**, porque la dosis puede incluir una corrección y la relación saldría inflada; la pantalla dice cuántas se descartaron.
- Es **solo informativo**: no cambia «Unidades de rápida por ración» ni la calculadora ni la previsión. Esa relación la fija el equipo médico y se escribe a mano en Ajustes.
- Ya **no se muestra** la «regla de 500»: con dosis diarias pequeñas se aleja mucho de la pauta real.
- Importante: la relación de Ajustes también la usa el modelo predictivo para convertir hidratos en subida de glucosa. Si no se parece a lo que realmente se pone, la curva prevista saldrá exagerada o escasa.

### Calculadora: pestaña «Regla del 50»

- Tercera pestaña de la calculadora (junto a *Comida* y *Corrección por hiperglucemia*). Calcula **raciones por unidad = 50 ÷ dosis diaria total** con la insulina diaria de rápida y de lenta de *Ajustes*
  (con raciones de 10 g; si cambian los gramos por ración, usa 500 ÷ dosis ÷ gramos). Función `ruleOf50` en `core/dose.ts`.
- Usa los mismos ingredientes de la pestaña *Comida* y da la dosis al momento, **al lado de la que sale con la relación de Ajustes**. Si ambas difieren más de un 25 %, avisa.
- Ajustes no cambia: «Unidades de rápida por ración» sigue siendo la relación que usan la pestaña *Comida* y el modelo predictivo.
- Es una **estimación general para comparar**: con dosis diarias pequeñas se aleja mucho de la pauta real. Por eso esta pestaña **no pasa el resultado al registro**. La dosis la decide la familia con su equipo médico.

## Aviso

Los valores de hidratos precargados son orientativos y editables; contrastadlos con la tabla de vuestro equipo de endocrinología. La app es una ayuda, no sustituye su criterio.
