# Justificación

Publica firestore.rules de nuevo en Firebase → Firestore → Reglas. Sin esto, las altas por invitación no funcionan.

Guarda una copia de las reglas actuales. Abre console.firebase.google.com, entra en tu proyecto glucokid-e655a y ve a Firestore Database (en el menú lateral, dentro de Compilación, o Build si lo tienes en inglés). Abre la pestaña Reglas (Rules). Copia todo el texto del editor y guárdalo en un fichero. Así podrás volver atrás si hiciera falta.
Abre el firestore.rules nuevo (el que te envié) con cualquier editor de texto y copia todo su contenido.
Sustituye el contenido del editor de la consola. Haz clic dentro del editor, selecciona todo (Ctrl+A), bórralo y pega el contenido nuevo. No lo mezcles con el anterior: tiene que quedar solo el fichero nuevo, empezando por rules_version = '2';.
Revisa que no haya errores. El editor subraya en rojo cualquier fallo de sintaxis y lo indica en un aviso encima o debajo. Si aparece alguno, no publiques: dime qué dice.
Pulsa «Publicar» (Publish), arriba a la derecha del editor. Se aplica en unos segundos.
Comprueba que se ha guardado. Debajo de la pestaña verás la fecha y hora de la última publicación. Recarga la página y confirma que el editor muestra las reglas nuevas.

Después, haz la prueba de comprobación de COMPARTIR-REGISTROS.md (invitación a ti mismo en una ventana de incógnito). Es la forma de saber que las reglas nuevas funcionan: yo no he podido verificarlas con el emulador.

Si algo falla tras publicar, repite el paso 3 con la copia del paso 1 para volver al estado anterior.
