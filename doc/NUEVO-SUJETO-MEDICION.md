# Añadir un niño nuevo y cómo se identifica cada niño

## Cómo funciona (resumen)

En GlucoKid **no existe una «ficha de niño» aparte**. Un niño es **una cuenta con datos propios**:

- Cada cuenta tiene un **UID** (identificador único de 28 caracteres que le asigna Firebase Authentication al crearla).
- Los datos del niño cuelgan de ese UID en Firestore:

`
users/{UID}                 ← perfil de la cuenta: email, name, role, active, (dataUid)
users/{UID}/days/{AAAA-MM-DD}   un documento por día (comidas, mediciones, actividad)
users/{UID}/config/settings     ajustes (pautas, factor de sensibilidad, cambios de sensor…)
users/{UID}/config/foods        catálogo de alimentos
users/{UID}/docs/{nombre}       documentación en Markdown
users/{UID}/alerts/…            avisos entre cuidadores
users/{UID}/devices/…           dispositivos que reciben avisos push
`

- Una cuenta **sin** `dataUid` es un **niño** («datos propios»). Aparece en la lista de niños.
- Una cuenta **con** `dataUid = UID_del_niño` es un **cuidador**: entra con su propio correo y contraseña, pero lee y escribe en
  `users/{UID_del_niño}/…`. Así varias personas comparten un niño (ver `COMPARTIR-NINO.md`).

**Identificar a un niño:** su identificador interno es el **UID de su cuenta** (anónimo, sin datos personales). Para las personas, cada niño se
identifica por su **nombre de niño** (`kidName`), que es el que se ve en la aplicación: el nombre o apodo con el que lo reconoce la familia («Ana», «Lucía»).
Es **distinto del nombre de la persona** de la cuenta (`name`), que es el que sale en los avisos («Mamá ha registrado…»). Así, una cuenta de padre o
madre puede ser a la vez el espacio donde se guardan los datos del niño sin que se confundan los dos nombres. Si no se pone nombre de niño se usa el de la cuenta.
Se edita en **Usuarios → «Nombre del niño»** (solo aparece en las cuentas con datos propios) y se puede cambiar cuando quieras sin afectar a los datos. No lo uses como clave.

**Cuentas, perfiles y datos (para no confundirse en la consola de Firebase):**

- **Authentication → Users**: quién puede entrar (correo, contraseña y UID).
- **Firestore → `users/{mismo UID}`**: el perfil de esa cuenta (`name`, `kidName`, `role`, `active`, `dataUid`/`dataUids`).
- **Firestore → `users/{UID}/days, config, docs…`**: los datos del niño, **solo** si la cuenta no tiene `dataUid` (es un espacio de datos).
- Es normal que tu cuenta de administrador sea, a la vez, el espacio de un niño (si es la cuenta con la que empezaste): ponle entonces tu nombre en
  «Nombre de la persona» y el del niño en «Nombre del niño».
Quien accede a un solo niño ve arriba «Datos de **Ana**»; quien accede a varios (o es administrador) ve un selector **Niño** con los nombres.
Para localizar un UID: Firebase → **Authentication → Users** (columna «User UID»), o Firestore → colección `users` (el ID de cada documento).

## Crear un niño nuevo (administrador)

Requisito: tu cuenta es **administrador**. Cada niño necesita **un correo propio y distinto** (Firebase no admite el mismo correo en dos cuentas).
Puedes usar un alias del tuyo si tu proveedor lo permite (por ejemplo `tunombre+ana@gmail.com` llega a `tunombre@gmail.com`
y para Firebase es un correo distinto). Ese correo sirve para restablecer la contraseña, así que debe poder recibir correo.

1. **Usuarios → Crear cuenta a mano**.
2. Rellena **Nombre** (de la persona o, si es solo la cuenta del niño, su nombre), **Correo** (el de esa cuenta), **Contraseña inicial** (mínimo 6 caracteres) y **Rol = Usuario**.
3. **Datos = «Propios (es un niño nuevo)»**, y aparece **Nombre del niño**: escribe el que usa la familia («Ana»). *(Es lo que lo convierte en un niño y no en un cuidador.)*
4. **Crear cuenta**. Aparece en la lista con la etiqueta «Datos propios».
5. Abre el selector **Niño** de la cabecera (solo lo ves como administrador) y elige al niño nuevo. La primera vez que entras, la aplicación crea
   su espacio con los **ajustes y el catálogo de alimentos por defecto**, que puedes adaptar en *Ajustes* y *Alimentos*
   (o importar un catálogo en JSON desde *Alimentos → Importar o exportar*).
6. Configura sus pautas en **Ajustes** (administraciones, unidades por defecto, raciones previstas, factor de sensibilidad, objetivo…).
7. Invita a sus cuidadores: **Usuarios → Invitar por enlace → Niño = el niño nuevo** (ver `COMPARTIR-NINO.md`).

Qué hacer con la cuenta del propio niño: no hace falta usarla para entrar. Puedes dejarle una contraseña larga que guardes tú
y que los cuidadores usen sus cuentas. Si prefieres que nadie entre con ella, **desactívala** *después* de crear las cuentas de los cuidadores:
desactivar una cuenta no borra los datos del niño, pero deja de poder acceder con ella (los cuidadores que comparten el espacio siguen accediendo).

## Varios niños en una cuenta (abuelos, tíos…)

Ejemplo: tres niños (Ana, Lucía y Pablo), con sus padres y unos abuelos que quieren ver a los tres.

1. Crea una cuenta **por niño** (apartado anterior), cada una con su nombre.
2. Los **padres** de cada niño: invítalos a su niño (**Usuarios → Invitar por enlace**), o marca los niños que correspondan.
3. Los **abuelos**: invítalos **una vez** a cualquiera de los niños (crean su cuenta con su correo) y, después, en **Usuarios**, en la fila de su cuenta,
   marca en **«Niños a los que accede»** los tres niños.
4. La próxima vez que entren (o recarguen la página) verán el selector **Niño** con «Ana», «Lucía» y «Pablo». El último que eligieron se recuerda en ese dispositivo.

Cómo se comporta:

- Cada cuenta ve **solo** los niños que tiene marcados (lo imponen las reglas de Firestore en el servidor).
- Los **avisos push** (con la app cerrada) llegan de **todos** los niños de la cuenta, y llevan el **nombre del niño** («⚠ Hipoglucemia de Ana»).
  Para que un dispositivo ya registrado reciba los de los niños añadidos después, en ese dispositivo: **Ajustes → Avisos → desactivar y volver a activar**.
- Los avisos **dentro de la aplicación** (banner y sonido, con la app abierta) son solo del niño que se está viendo.
- Una cuenta de niño que ya tiene cuidadores no puede, a su vez, cuidar de otros niños (la casilla aparece bloqueada).
- Si desmarcas todos los niños de una cuenta, esa cuenta pasa a ser un niño con datos propios: hazlo solo si es lo que quieres.

## Qué se comparte y qué no

- **Por niño** (lo comparten sus cuidadores): registros, ajustes, catálogo de alimentos, documentos, cambios de sensor y estadísticas.
- **Por cuenta** (personal): sesión, avisos silenciados, sonido y dispositivos que reciben avisos push.
- Las copias de seguridad (*Ajustes → Copia de seguridad*) son **del niño que estás viendo** en ese momento.

## Cambiar o consultar a qué niños accede una cuenta

- **Usuarios → «Niños a los que accede»** en la fila de la cuenta: ninguna casilla = niño con datos propios; una o varias = cuidador de esos niños.
- Cambiarlo **no mueve datos**: solo cambia hacia qué espacio apunta la cuenta.

## Si la base de datos crece (notas para el futuro)

- **Aislamiento.** Cada niño es un árbol independiente (`users/{UID}/…`); las reglas de Firestore (`firestore.rules`) impiden que una cuenta
  acceda a otro niño salvo los administradores. Añadir niños no afecta a los demás.
- **Tamaño.** Un día es un documento pequeño. El catálogo (`config/foods`) y los ajustes (`config/settings`) son **un solo documento cada uno**;
  Firestore limita un documento a 1 MiB, que da de sobra para miles de alimentos (la importación limita a 2000).
- **Lecturas (plan gratuito).** El límite diario es de unas 50 000 lecturas. Lo que más consume: abrir *Evolución → Año* (unos 700 días entre el año
  actual y el anterior) y la pestaña *Monitor* (hasta 180 días). Con pocos niños no es un problema; con muchos, conviene guardar
  resúmenes por mes en lugar de recorrer todos los días.
- **No hay consultas entre niños.** Todo se calcula dentro del espacio de un niño. Si algún día se quieren estadísticas globales,
  habría que añadir una colección de resúmenes y una función que la alimente.
- **Una persona con varios niños** (unos abuelos con tres nietos, por ejemplo): una misma cuenta puede acceder a **varios niños** (`dataUids` en su perfil,
  con `dataUid` como el predeterminado). Se gestiona en **Usuarios → «Niños a los que accede»** (casillas por niño). Ver «Varios niños en una cuenta».
- **Identificador estable.** El UID no cambia nunca, ni aunque se cambie el correo o el nombre. Cualquier dato derivado (copias, exportaciones, resúmenes)
  debe guardar el UID del niño, como ya hace la copia de seguridad (`dataUid`).

## Borrar un niño (con cuidado)

- **Desactivar** la cuenta es reversible y no borra nada: es lo recomendable.
- Borrar la cuenta en *Authentication → Users* **no borra sus datos** de Firestore: `users/{UID}/…` queda ahí hasta que se borre a mano desde
  la consola (colección `users` → documento → eliminar, **incluidas sus subcolecciones** `days`, `config`, `docs`, `alerts`, `devices`; la consola
  ofrece «Eliminar subcolecciones» al borrar el documento). Antes, **descarga la copia de seguridad** de ese niño.
- Si otras cuentas comparten ese niño, desmárcalo antes en ellas (*Usuarios → «Niños a los que accede»*), o quedarán apuntando a un espacio vacío.
- Los datos son de salud: bórralos de verdad si ya no se necesitan y no guardes copias descargadas sin protección.

## Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| «Ya existe una cuenta con ese correo» | Ese correo ya está registrado. Usa otro (o un alias) para el niño nuevo. |
| El niño nuevo no aparece en el selector **Niño** | Se creó con «Comparte los datos de …» en vez de «Propios (es un niño nuevo)». Cámbialo en **Usuarios →** desmarca todas sus casillas de «Niños a los que accede». |
| No veo el selector **Niño** | Solo lo ven los administradores. |
| El niño nuevo aparece con los alimentos y pautas por defecto | Es lo previsto: cada niño empieza con los valores por defecto; configúralos en *Ajustes* y *Alimentos*. |
| Un cuidador ve los datos de otro niño | Revisa sus casillas de «Niños a los que accede» en *Usuarios*. |
| Un cuidador no ve el selector **Niño** | Solo aparece si la cuenta tiene **más de un** niño marcado. Que cierre y vuelva a abrir la aplicación tras marcarlos. |
| «Cuenta sin acceso» o sin datos de un niño recién marcado | Publica las **reglas nuevas** (`firestore.rules`): sin ellas, el segundo niño no se puede leer. |
