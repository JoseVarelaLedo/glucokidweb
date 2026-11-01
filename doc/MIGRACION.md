# Pasar de la versión anterior a esta (qué respaldar y qué hacer)

**Tus datos no están en el código**: viven en Firestore (proyecto Firebase). Actualizar el código
NO los toca. Lo único tuyo que hay dentro del código es la configuración de Firebase.

## 1. Qué guardar antes de tocar nada

| Qué | Dónde está | Cómo respaldarlo |
|---|---|---|
| Tu configuración de Firebase | `src/app/core/firebase.config.ts` (es lo único que tú cambiaste) | Copia el fichero a un lugar seguro |
| Los datos (días, ajustes, alimentos) | Firestore | En la app, **Ajustes → Copia de seguridad → Descargar** (JSON). Hazlo con cada niño (selector «Niño» si eres admin) |
| Reglas de seguridad publicadas | Consola Firebase → Firestore → Reglas | Copia el texto actual a un fichero |
| Perfiles de usuario (rol, activo) | Firestore, colección `users` | Quedan en Firestore; no hay que hacer nada |
| Netlify (sitio, dominio, variables; si activas push, `FIREBASE_SERVICE_ACCOUNT`) | Panel de Netlify | No cambia si sigues desplegando el mismo sitio |
| Firebase Auth: dominios autorizados | Consola → Authentication → Configuración | No cambia |

## 2. Pasos

1. Haz las copias de la tabla.
2. Descomprime el zip nuevo en una carpeta nueva.
3. Sustituye `src/app/core/firebase.config.ts` por tu fichero guardado
   (con `export const firebaseConfig = {...}` y `export const firebaseEnabled = ...`, como ya lo tenías).
4. `npm install` (hay dos dependencias nuevas: `marked` y `dompurify`). No uses `npm audit fix --force`.
5. **Publica las nuevas reglas**: copia `firestore.rules` en Consola Firebase → Firestore → Reglas → Publicar.
   Sin este paso no funcionarán los documentos, los avisos ni las cuentas compartidas.
6. (Opcional) Avisos push con la app cerrada: sigue `PUSH.md` (clave pública en `push.config.ts` y clave del servidor solo en Netlify).
   Ojo: para que la función `netlify/functions` se publique, Netlify tiene que construir el proyecto (Git o CLI);
   arrastrar solo la carpeta `dist` no la incluye.
7. `npm run build` y despliega en Netlify.

## 3. Qué ocurre con tus datos

- Los **ajustes** se migran solos a la versión 2: se añade «Media mañana» (opcional) tras el desayuno.
- Las **mediciones intermedias** colgadas de la insulina lenta se reubican solas (pasan a «post cena»).
- El factor de sensibilidad usa ahora siempre la constante 1700 (ya no se elige regla). Si tenías uno calculado con 1800/1500,
  pulsa de nuevo «Calcular factor de sensibilidad» en Ajustes. Las unidades por defecto de cada comida se configuran en Ajustes
  (empiezan sin propuesta).
- **Altas por invitación**: las nuevas reglas de `firestore.rules` (colección `invites` y alta del propio perfil) hay que **publicarlas de nuevo**
  en la consola de Firebase. Guía de uso en `COMPARTIR-NINO.md`.
- Los días antiguos se abren igual que antes; los campos nuevos (nota, raciones adicionales) salen vacíos.
- **Cuentas compartidas**: no hay migración. Con tu cuenta de administrador, ve a *Usuarios*, crea una cuenta
  por persona y en «Datos» elige el espacio del niño. Cada una entra con su correo y todas ven lo mismo.
- Si algo saliera mal, vuelves al zip anterior y restauras el JSON desde Ajustes.
