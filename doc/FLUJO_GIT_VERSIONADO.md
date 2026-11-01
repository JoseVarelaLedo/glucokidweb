# Comandos para versionar y etiquetar correctamente la aplicación

`git status` -->

`git add .` si queremos añadir todo

`git add ARCHIVO QUE SEA` si queremos añadir sólo contenido concreto

(comandos reemplazables por **GitFlow** para usar por interfaz, o plugin equivalente)

`git commit -m "MENSAJE PERSONALIZADO DEL COMMIT"`

`git push origin develop` --> se envía sólo la rama **develop**

`git tag -a v2.0.0 -m "ETIQUETA DE VERSIONADO, LA QUE QUERAMOS"`

`git checkout release` --> moverse a la rama de **PRODUCCIÓN** / **DESPLIEGUE**

`git merge --ff-only develop` --> fusionamos cambios de la rama **develop** en la rama **release**

`git push origin release` --> se sube al repositorio remoto la rama **release**

`git push origin v1.0.0` --> sustituir por la versión que hayamos definido antes

`git checkout develop` --> volvemos a la rama de desarrollo

## En caso de error etiquetando, por ejemplo crear mal la etiqueta

```bash
git tag -d v.2.5.0
git tag -a v2.5.0 -m "Añadido campo nombre niño como alias"
git push origin v2.5.0
```
