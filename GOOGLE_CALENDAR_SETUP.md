# Sincronizar el calendario de la app con Google Calendar — Guía paso a paso

El calendario **principal es el de la app**. Los eventos se crean, editan y borran
ahí. Google Calendar es una **copia** que se actualiza cuando vos apretás
**Sincronizar Google**, para verlos también en el celular o compartirlos.

## ¿Cómo funciona?

La app usa una **Service Account** (una "cuenta de robot" de Google). Cuando
sincronizás, el servidor escribe en el Google Calendar del equipo usando esa cuenta,
sin que cada usuario tenga que loguearse con Google. Para que funcione hay que
**compartir** el calendario del equipo con el email de la service account y darle
permiso de **"Hacer cambios en los eventos"**.

> La sincronización va **siempre en un solo sentido: app → Google**. Lo que edites
> directamente en Google Calendar no vuelve a la app, y la próxima sincronización
> lo pisa con lo que dice la app.

---

## Parte 1 — Google Cloud (lo hacés vos una sola vez)

### 1. Crear/elegir un proyecto en Google Cloud
1. Entrá a https://console.cloud.google.com/
2. Arriba a la izquierda, en el selector de proyecto → **Proyecto nuevo**.
3. Nombre: por ej. `consultoria-digital-calendar` → **Crear**.
4. Asegurate de tener ese proyecto seleccionado.

### 2. Habilitar la API de Google Calendar
1. Menú ☰ → **APIs y servicios** → **Biblioteca**.
2. Buscá **Google Calendar API** → **Habilitar**.

### 3. Crear la Service Account
1. Menú ☰ → **APIs y servicios** → **Credenciales**.
2. **Crear credenciales** → **Cuenta de servicio**.
3. Nombre: `calendar-bot` (el que quieras) → **Crear y continuar**.
4. No hace falta asignar roles ni usuarios → **Listo**.

### 4. Descargar la clave JSON
1. En **Credenciales**, abrí la service account recién creada.
2. Pestaña **Claves** → **Agregar clave** → **Crear clave nueva** → tipo **JSON** → **Crear**.
3. Se descarga un archivo `.json`. **Guardalo bien, es secreto** (no lo subas a Git).
4. Abrí el JSON y anotá el valor de `client_email`
   (algo como `calendar-bot@tu-proyecto.iam.gserviceaccount.com`).
   Ese email es el que vas a usar para compartir los calendarios.

---

## Parte 2 — Configurar la app

### 5. Apuntar la app a la service account
Elegí **una** de las dos opciones en tu `.env`:

**Opción A — archivo (cómodo en local):**
1. Copiá el `.json` descargado dentro del proyecto, por ej. `secrets/gcal-service-account.json`.
2. Agregalo a `.gitignore` (¡no lo subas!).
3. En `.env`:
   ```env
   GOOGLE_SERVICE_ACCOUNT_FILE=./secrets/gcal-service-account.json
   ```

**Opción B — JSON en variable (cómodo en hosting tipo Railway/Render):**
1. Pegá el JSON completo en **una sola línea** en `.env`:
   ```env
   GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"calendar-bot@...iam.gserviceaccount.com", ...}
   ```
   > Las barras `\n` dentro de `private_key` deben quedar tal cual (literales). La app
   > las convierte a saltos de línea automáticamente.

4. **Reiniciá el servidor** (`npm start` / `npm run dev`).

### 6. (Opcional) Verificar zona horaria
En `.env`, `GOOGLE_CALENDAR_CTZ` define la zona horaria de los eventos con hora.
Por defecto: `America/Argentina/Buenos_Aires`.

---

## Parte 3 — Conectar cada calendario de equipo

Repetí esto para **cada equipo** que quiera espejo en Google (marketing, desarrollo, admin).

### 7. Compartir el calendario con la service account
1. Entrá a https://calendar.google.com/ con la cuenta dueña del calendario.
2. A la izquierda, pasá el mouse por el calendario del equipo →  ⋮ → **Configuración y uso compartido**.
   - Si querés un calendario nuevo: **Crear calendario** primero.
3. En **Compartir con usuarios o grupos específicos** → **Agregar personas**.
4. Pegá el **`client_email`** de la service account (paso 4).
5. En permisos elegí **"Hacer cambios en los eventos"** → **Enviar**.

### 8. Copiar el ID del calendario
1. En esa misma pantalla, bajá hasta **Integrar calendario**.
2. Copiá el **ID de calendario** (algo como `xxxxx@group.calendar.google.com`,
   o tu email si es el calendario principal).

### 9. Configurar el calendario en la app
1. Entrá a la app → pestaña **CALENDARIO**.
2. Botón **Google Cal** (arriba a la derecha) → se abre "Configurar Google Calendar".
3. Pegá el **ID de calendario** (o la URL de inserción) → **Guardar**.
4. Listo: si la service account está bien configurada y tiene permiso de edición,
   aparece el botón **Sincronizar Google** en la pestaña CALENDARIO.

---

## Parte 4 — Usarlo

En la pestaña **CALENDARIO**:

- **Crear evento:** clic en el número de un día → título, fecha, hora, color →
  **Guardar**. Queda en la app al instante.
- **Editar / borrar:** clic en un evento → modificás o **Eliminar**.
- **Llevarlo a Google:** botón **Sincronizar Google** arriba a la derecha. Empuja
  todos los cambios del mes que estás viendo: crea los eventos nuevos, actualiza los
  editados y borra en Google los que borraste en la app.
- **Un evento suelto:** abrí el evento y usá **Agendar en Google**.
- **Ver Google:** botón **Ver Google**, muestra el calendario embebido de Google en
  modo solo lectura. Volvés con **Ver agenda**.

## Cómo saber qué falta sincronizar

- El botón muestra cuántos cambios hay pendientes, por ejemplo
  **Sincronizar Google (3)**. Si no hay nada pendiente dice **Google al día**.
- Los eventos que todavía no viajaron a Google llevan un **punto ámbar** en la grilla.
- Al abrir un evento, un texto abajo del formulario dice si está sincronizado, si
  nunca se envió o si quedó desactualizado.
- Si el equipo no tiene service account o calendario configurado, el botón no
  aparece y la app funciona igual, solo que sin espejo en Google.

## Problemas comunes

| Síntoma | Causa probable | Solución |
|---|---|---|
| No aparece el botón "Sincronizar Google" | Falta `GOOGLE_SERVICE_ACCOUNT_FILE`/`_JSON`, o el equipo no tiene calendario configurado | Revisá `.env`, reiniciá, y configurá el calendario (pasos 7 a 9) |
| "Google Calendar no esta configurado en el servidor." | El server no ve la service account | Revisá `.env` y reiniciá |
| La sincronización avisa errores + 404 | El calendario no está compartido con la service account, o el ID es incorrecto | Repetí pasos 7 y 8 |
| Sincroniza pero no aparece en Google | Permiso de solo "Ver" en vez de "Hacer cambios" | Cambiá el permiso en el paso 7 |
| Las horas salen corridas | Zona horaria distinta | Ajustá `GOOGLE_CALENDAR_CTZ` |
| Edité en Google y se perdió | Google es solo espejo | Editá siempre en la app |

## Seguridad

- El archivo JSON de la service account es **secreto**: nunca lo subas a Git.
  Agregá `secrets/` y `*.json` de credenciales al `.gitignore`.
- Si se filtra, borrá la clave en Google Cloud (Credenciales → Service account →
  Claves) y generá una nueva.
