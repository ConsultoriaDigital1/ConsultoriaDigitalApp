# Google Calendar editable — Guía paso a paso

Esta guía deja el calendario de Google **editable** dentro de la app: crear, editar
y borrar eventos desde la grilla del calendario, y que esos cambios aparezcan en el
**Google Calendar de verdad**.

## ¿Cómo funciona?

La app usa una **Service Account** (una "cuenta de robot" de Google). El servidor
escribe en el Google Calendar de cada equipo usando esa cuenta, sin que cada usuario
tenga que loguearse con Google. Para que funcione, hay que **compartir** cada
calendario del equipo con el email de la service account y darle permiso de
**"Hacer cambios en los eventos"**.

> Importante: el `<iframe>` embebido de Google es de **solo lectura** (limitación de
> Google). Por eso, cuando hay service account configurada, la app reemplaza el iframe
> por una **grilla propia editable** que lee y escribe vía la API de Google Calendar.

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

Repetí esto para **cada equipo** que quiera calendario editable (marketing, desarrollo, admin).

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
   el calendario se vuelve **editable** automáticamente.

---

## Parte 4 — Usarlo

- **Crear evento:** clic en el número de un día → completás título, fecha, hora
  (opcional), color → **Guardar**. Aparece al instante y en Google Calendar.
- **Editar / borrar:** clic en un evento → modificás o **Eliminar**.
- Si dejás la hora vacía, se crea como **evento de día completo**.

---

## Cómo saber si quedó editable

- Si **no** hay service account configurada, o el calendario no tiene un ID válido,
  la app muestra el **iframe de solo lectura** de siempre (no se rompe nada).
- Si **sí** está todo bien, el subtítulo del calendario dice
  **"… - Google Calendar · <mes>"** y podés crear eventos haciendo clic en los días.

## Problemas comunes

| Síntoma | Causa probable | Solución |
|---|---|---|
| "Google Calendar no esta configurado en el servidor." | Falta `GOOGLE_SERVICE_ACCOUNT_FILE`/`_JSON` o el server no se reinició | Revisá `.env` y reiniciá |
| "No se pudieron cargar los eventos…" + 404 | El calendario no está compartido con la service account, o el ID es incorrecto | Repetí pasos 7 y 8 |
| Crea pero no aparece en Google | Permiso de solo "Ver" en vez de "Hacer cambios" | Cambiá el permiso en el paso 7 |
| Las horas salen corridas | Zona horaria distinta | Ajustá `GOOGLE_CALENDAR_CTZ` |

## Seguridad

- El archivo JSON de la service account es **secreto**: nunca lo subas a Git.
  Agregá `secrets/` y `*.json` de credenciales al `.gitignore`.
- Si se filtra, borrá la clave en Google Cloud (Credenciales → Service account →
  Claves) y generá una nueva.
