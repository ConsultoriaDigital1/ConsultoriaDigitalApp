# Cobranzas: configuración de ARCA (factura electrónica) + n8n (avisos)

La sección **Administración → Cobranzas** lista los clientes con saldo pendiente y permite:

1. **Facturar**: emite una factura electrónica real en ARCA (vía web services WSAA + WSFEv1, sin entrar al portal) y obtiene el CAE.
2. **Aviso**: dispara un webhook a n8n con los datos del cliente y la factura, para que n8n envíe el mensaje (WhatsApp, mail, etc.).

Todo se configura con variables en `.env`. Sin configurar, la sección funciona igual pero con los botones deshabilitados.

---

## Parte 1 — ARCA (factura electrónica)

### Paso 1: Generar clave privada y pedido de certificado (CSR)

En una terminal con OpenSSL (Git Bash lo trae en Windows: `C:\Program Files\Git\usr\bin\openssl.exe`):

```bash
mkdir -p .local/arca
openssl genrsa -out .local/arca/private.key 2048
openssl req -new -key .local/arca/private.key -subj "/C=AR/O=TuNombreORazonSocial/CN=consultoriadigital/serialNumber=CUIT 20XXXXXXXXX" -out .local/arca/pedido.csr
```

Reemplazá `20XXXXXXXXX` por **tu CUIT sin guiones** y `TuNombreORazonSocial` por tu nombre tal como figura en ARCA.

### Paso 2: Obtener el certificado en ARCA

**Para probar (homologación — recomendado para empezar):**
1. Entrá a [ARCA](https://www.afip.gob.ar) con tu clave fiscal.
2. Buscá el servicio **"WSASS – Autogestión de certificados de homologación"** (si no aparece, agregalo desde "Administrador de Relaciones de Clave Fiscal").
3. En WSASS → **Nuevo certificado**: pegá el contenido de `pedido.csr`, poné un alias (ej. `consultoriadigital`) y descargá el certificado. Guardalo como `.local/arca/cert.crt`.
4. En WSASS → **Crear autorización a servicio**: autorizá tu DN al servicio **wsfe** (homologación).

**Para producción (facturas reales):**
1. Servicio **"Administración de Certificados Digitales"** → Agregar alias → pegá el CSR → descargá el certificado como `.local/arca/cert.crt`.
2. Servicio **"Administrador de Relaciones de Clave Fiscal"** → Nueva relación → servicio **"Facturación Electrónica" (wsfe)** → asociala al certificado (alias) creado.
3. Asegurate de tener un **punto de venta** tipo "Web Services" dado de alta en "Administración de puntos de venta y domicilios" (RECE/factura electrónica). Anotá su número.

### Paso 3: Configurar `.env`

Descomentá y completá en `.env`:

```ini
ARCA_CUIT=20XXXXXXXXX          # tu CUIT, solo números
ARCA_PRODUCTION=false          # false = homologación (pruebas), true = facturas reales
ARCA_CERT_PATH=./.local/arca/cert.crt
ARCA_KEY_PATH=./.local/arca/private.key
ARCA_PTO_VTA=1                 # punto de venta (en homologación 1 funciona)
```

### Dos cuentas emisoras

La app permite asignar una cuenta emisora a cada cliente. Conservá las variables
`ARCA_*` actuales para la cuenta existente y agregá las de COMYDES:

```ini
ARCA_COMYDES_CUIT=30719537614
ARCA_COMYDES_CERT_PATH=./.local/arca-comydes/cert.crt
ARCA_COMYDES_KEY_PATH=./.local/arca-comydes/private.key
ARCA_COMYDES_PTO_VTA=1
ARCA_COMYDES_PRODUCTION=false
ARCA_COMYDES_RAZON_SOCIAL=COMYDES
ARCA_COMYDES_DOMICILIO=Domicilio legal de COMYDES
ARCA_COMYDES_INICIO_ACTIVIDADES=DD/MM/AAAA
```

En el formulario del cliente, seleccioná **COMYDES** como cuenta emisora. Los
clientes existentes quedan asignados a la cuenta `ARCA_*` actual. Cada factura
y cada borrador conserva la cuenta con la que fue creado.

El PDF reutiliza el logo configurado en `ARCA_LOGO_PATH` y muestra debajo el
nombre legal del emisor. Si se necesita un logo distinto para COMYDES, se puede
agregar `ARCA_COMYDES_LOGO_PATH` apuntando a otro archivo de imagen.

Reiniciá el servidor (`npm run dev`). En la pestaña Cobranzas el chip debería decir **"ARCA homologación (prueba)"**.

### Paso 4: Probar

1. Andá a **Administración → Cobranzas**.
2. Elegí un cliente con saldo y tocá **Facturar**.
3. Tipo de comprobante: **Factura C** si sos monotributista, **A/B** si sos responsable inscripto (en A/B el sistema asume IVA 21% incluido en el total).
4. Si sale todo bien, vas a ver el **CAE**, el número de comprobante y el link al QR de ARCA.

> En homologación las facturas **no tienen validez fiscal**: probá tranquilo. Cuando todo funcione, repetí el paso 2 en producción, cambiá `ARCA_PRODUCTION=true` y apuntá `ARCA_CERT_PATH` al certificado de producción.

**Notas:**
- El ticket de acceso de ARCA dura 12 h y se cachea en `.local/arca-ta.json`, no hace falta tocarlo.
- "Sumar también como movimiento" agrega la factura al debe del cliente. Dejalo destildado si el saldo ya incluía ese monto (caso típico: facturás una deuda ya cargada).

---

## Parte 2 — n8n (envío del aviso)

### Paso 1: Crear el workflow en n8n

1. Nuevo workflow → nodo **Webhook**: método `POST`, path `aviso-cobranza`. Copiá la **Production URL**.
2. Conectá el nodo que envíe el mensaje. El payload que llega es:

```json
{
  "evento": "aviso_cobranza",
  "mensaje": "Hola Cliente! Te recordamos que tenés un saldo pendiente de $ 150.000 ...",
  "cliente": {
    "nombreFantasia": "...", "razonSocial": "...", "cuit": "...",
    "telAdmin": "549351...", "telDueno": "...", "mail1": "...",
    "vence": "2026-06-30", "saldo": 150000
  },
  "factura": { "numero": "0001-00000042", "cae": "...", "impTotal": 150000, "qrUrl": "https://..." }
}
```

   - **WhatsApp**: nodo de Evolution API / WAHA / API oficial de Meta, usando `{{ $json.cliente.telAdmin }}` y `{{ $json.mensaje }}`.
   - **Email**: nodo Gmail/SMTP con `{{ $json.cliente.mail1 }}`.
   - `factura` viene en `null` si el aviso no está asociado a una factura.
3. **Activá el workflow** (toggle "Active").

### Paso 2: Configurar `.env`

```ini
N8N_WEBHOOK_URL=https://tu-n8n.com/webhook/aviso-cobranza
N8N_WEBHOOK_TOKEN=un_token_secreto   # opcional: llega como header Authorization: Bearer ...
```

Si usás el token, validalo en n8n (Webhook → Authentication → Header Auth).

### Paso 3: Probar

Reiniciá el servidor, entrá a Cobranzas y tocá **Aviso** en un cliente. Si n8n responde OK, queda registrado en la columna "Último aviso".

---

## Checklist final

- [ ] OpenSSL: clave + CSR generados en `.local/arca/`
- [ ] Certificado de homologación descargado y autorizado al servicio `wsfe` (WSASS)
- [ ] `.env` con `ARCA_*` completos y servidor reiniciado
- [ ] Factura de prueba emitida con CAE en homologación
- [ ] Workflow n8n activo y `N8N_WEBHOOK_URL` en `.env`
- [ ] Aviso de prueba recibido
- [ ] (Producción) certificado real + punto de venta Web Services + `ARCA_PRODUCTION=true`
