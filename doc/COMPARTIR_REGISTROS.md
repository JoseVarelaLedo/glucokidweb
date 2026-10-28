# Compartir un niño entre varias personas (cuentas distintas)

En GlucoKid cada **niño** tiene su propio espacio de datos (registros, alimentos, ajustes, documentos). Varias personas
(padre, madre, abuela…) pueden usar **el mismo espacio** cada una con **su propia cuenta** (su correo y su contraseña).

## Por qué cuentas distintas y no una sola en varios móviles
- **Los avisos solo funcionan entre cuentas distintas.** Quien registra una hipoglucemia o hiperglucemia no recibe su propio aviso;
  con una cuenta única, todos serían «la misma persona» y nadie recibiría nada.
- Cada aviso y cada registro indican **quién** lo hizo.
- Puedes **desactivar** a una persona sin cambiar la contraseña de las demás.
- Cada persona cambia su contraseña sin afectar al resto.

Los datos no se duplican ni se migran: todas las cuentas leen y escriben **el mismo** espacio.

## Antes de empezar (una sola vez)
1. Actualiza la aplicación con esta versión y **publica las reglas nuevas**: copia `firestore.rules` en
   Consola de Firebase → Firestore Database → **Reglas** → **Publicar**. Sin esto, las invitaciones no funcionan.
2. Tu cuenta debe ser **administrador** (la que creaste a mano al principio). Solo los administradores ven la pestaña **Usuarios**.
3. En Firebase → Authentication → Settings → **Authorized domains** debe estar el dominio de la web (si ya entras con tu cuenta, lo está).

## Opción A (recomendada): invitar por enlace
La persona invitada crea ella misma su cuenta; no tienes que conocer su contraseña.

**Tú (administrador):**
1. **Usuarios → Invitar por enlace**.
2. **Niño**: elige el niño cuyos datos se compartirán (la cuenta que ya tiene el historial).
3. *Para quién* (opcional, solo para que lo reconozcas) y **Caduca en** (1, 3, 7 o 30 días).
4. **Crear invitación** → aparece el enlace. Pulsa **Copiar enlace**, **WhatsApp** o **Compartir…** y envíaselo **solo a esa persona**.

**La persona invitada:**
1. Abre el enlace en su móvil u ordenador (`https://tu-sitio.netlify.app/unirse/…`).
2. Escribe su nombre, su correo y una contraseña (mínimo 6 caracteres) dos veces → **Crear mi cuenta**.
3. Entra directamente en la aplicación, viendo los datos del niño. Las próximas veces entra con su correo y contraseña.
4. Si quiere recibir avisos con la aplicación cerrada: **Ajustes → Avisos entre cuidadores** en su móvil (ver `PUSH.md`).

**Cómo funciona la seguridad:**
- El enlace lleva un código aleatorio imposible de adivinar, es de **un solo uso** (al crearse la cuenta se borra) y **caduca**.
- La cuenta nueva siempre es **usuario normal** (nunca administrador) y solo accede al niño de la invitación. Esto lo imponen las
  reglas de Firestore en el servidor, no la pantalla.
- Quien tenga el enlace puede crear una cuenta, así que no lo publiques ni lo pongas en grupos grandes. Si se envía a quien no
  debía: **Usuarios → Invitaciones pendientes → Anular**, y el enlace deja de funcionar.
- Las invitaciones pendientes se ven en esa misma lista (con su caducidad); puedes **copiar de nuevo el enlace** o **anularlas**.

## Opción B: crear la cuenta tú
**Usuarios → Crear cuenta a mano**: nombre, correo, contraseña inicial, **Datos = «Comparte los datos de …»** y rol *Usuario*.
Después, dile la contraseña inicial por un canal seguro; puede cambiarla con **Restablecer contraseña** (te llega un correo).

## Tu caso: ya usas una cuenta en varios móviles
1. Tu cuenta actual **conserva todo el historial**; no la toques. Será el «niño» al que se enlazan las demás.
2. Invita (Opción A) a cada persona que use hoy esa cuenta, **excepto a ti**.
3. En cada móvil de otra persona: **Cerrar sesión** (al cerrar sesión se borra la caché local) y entrar con su cuenta nueva.
4. Tú sigues con la tuya. Cuando todos tengan su cuenta, cambia tu contraseña si la habías compartido
   (en la pantalla de acceso, o con **Restablecer contraseña** desde Usuarios).

## Gestionar después
| Quiero… | Dónde |
|---|---|
| Ver los datos de cualquier niño | Selector **Niño** de la cabecera (solo administradores) |
| Quitar el acceso a alguien | **Usuarios → Desactivar** (no borra sus registros anteriores, que son del niño) |
| Cambiar con qué niño comparte una cuenta | **Usuarios →** «Datos que usa» en su fila |
| Añadir un segundo niño | **Crear cuenta a mano** con *Datos = Propios*; luego invita a sus cuidadores a ese niño |
| Hacer administrador a otra persona | **Usuarios → Hacer admin** |

Qué comparte quien usa el espacio de un niño: registros, ajustes (pautas, factor de sensibilidad…), catálogo de alimentos y documentos.
Lo que es personal de cada cuenta: sus avisos silenciados, el sonido y los dispositivos que reciben avisos push.

## Prueba de comprobación (5 minutos, tras publicar las reglas)
1. Como administrador, crea una invitación para ti mismo (caduca en 1 día).
2. Ábrela en una **ventana de incógnito**, crea una cuenta con otro correo tuyo.
3. Comprueba que entra, ve los datos del niño y **no** ve la pestaña Usuarios.
4. En tu sesión de administrador: la invitación ha desaparecido de «Invitaciones pendientes» (se consumió) y el usuario aparece en la lista.
5. Vuelve a abrir el mismo enlace en incógnito: debe decir que la invitación **no existe o ya se usó**.
6. Desactiva esa cuenta de prueba.

## Problemas frecuentes
| Síntoma | Causa y solución |
|---|---|
| «La invitación ya no es válida» al crear la cuenta | Se usó, caducó o se anuló; o las **reglas nuevas no están publicadas**. Crea otra invitación y revisa las reglas. |
| «Ya existe una cuenta con ese correo» | Ese correo ya está registrado. Que entre con ella y, como administrador, enlázala al niño en **Usuarios → «Datos que usa»**. |
| Tras crear la cuenta: «Cuenta sin acceso» | El perfil no se guardó. Cierra sesión, pide otra invitación y repite (si persiste, mira las reglas). |
| La invitación abre la pantalla de acceso en vez de la de alta | La URL no es del tipo `/unirse/código`, o se copió incompleta. Copia de nuevo el enlace entero. |
| No me deja abrir el enlace con la sesión iniciada | Es lo previsto: cierra la sesión primero (la pantalla ofrece el botón). |
| En modo local (sin Firebase) | Las invitaciones requieren Firebase: la pantalla avisa de ello. |
