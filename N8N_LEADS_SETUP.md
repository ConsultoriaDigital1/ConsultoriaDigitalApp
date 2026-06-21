# Integracion n8n: enriquecer y mover leads

## Objetivo

Cuando n8n detecte que el cliente informo empresa, CUIT y actividad/rubro, debe llamar a la app para guardar esos datos en la tarjeta de Ventas. Si ademas el lead cumple la condicion comercial definida en el workflow, puede mover la tarjeta desde `contactado` hacia `presupuestado`.

## Metodo recomendado

Usar un nodo **HTTP Request** de n8n con metodo **POST**.

Endpoint para guardar datos sin mover de columna:

```txt
POST https://TU-DOMINIO/api/external/leads/enrich
```

Endpoint para guardar datos y mover a `presupuestado` si estaba en `contactado`:

```txt
POST https://TU-DOMINIO/api/external/leads/presupuestar
```

En local:

```txt
POST http://localhost:3000/api/external/leads/enrich
POST http://localhost:3000/api/external/leads/presupuestar
```

`/api/external/leads/enrich`:

- Busca la tarjeta por `cardId`, telefono o JID.
- Actualiza empresa, CUIT, actividad/rubro y servicio/interes.
- No cambia el estado de la tarjeta.
- Si mandas `createIfMissing: true` y hay telefono, crea un lead en `contactado`.
- Emite el cambio en tiempo real para que el tablero se actualice.

`/api/external/leads/presupuestar`:

- Busca la tarjeta por `cardId` o por telefono.
- Actualiza empresa, CUIT, actividad/rubro y servicio/interes si vienen en el body.
- Solo mueve la tarjeta si esta en `contactado`.
- Si ya fue movida antes, responde `noop` o `skipped` y no duplica el historial.
- Emite el cambio en tiempo real para que el tablero se actualice.

## Seguridad

El request debe incluir este header:

```txt
x-api-key: valor_de_EXTERNAL_API_KEY
```

La variable ya existe en `.env` como `EXTERNAL_API_KEY`. No la pongas fija en el workflow si podes evitarlo; guardala como credential o variable segura en n8n.

## Body JSON minimo

Actualizar datos relevantes del lead y, si corresponde, moverlo a `presupuestado`:

```json
{
  "phone": "5491123456789",
  "empresa": "ACME SRL",
  "cuit": "30-12345678-9",
  "actividad": "Fabrican y venden muebles a medida",
  "servicio": "CRM y gestion de redes",
  "motivo": "El lead informo empresa, CUIT y actividad"
}
```

Buscar por telefono:

```json
{
  "phone": "5491123456789",
  "motivo": "Lead calificado por workflow de n8n"
}
```

Buscar por JID de WhatsApp, si el workflow todavia no tiene telefono normalizado:

```json
{
  "jid": "231253974491241@lid",
  "motivo": "Lead calificado por workflow de n8n"
}
```

Buscar por id de tarjeta:

```json
{
  "cardId": "id-de-la-tarjeta",
  "motivo": "Lead calificado por workflow de n8n"
}
```

Tambien se aceptan estos nombres de telefono si vienen de otro webhook:

- `cleanedSenderPN`
- `cleanedSenderPn`
- `senderPn`
- `senderPN`
- `senderPhone`
- `data.messages.key.cleanedSenderPN`
- `data.messages.key.cleanedSenderPn`
- `data.messages.key.senderPn`

Y estos nombres de JID/alias de WhatsApp:

- `jid`
- `chatJid`
- `remoteJid`
- `lidAlias`
- `data.messages.key.remoteJid`

Campos de empresa aceptados:

- Empresa / razon social: `empresa`, `nombreEmpresa`, `razonSocial`, `companyName`, `company`, `businessName`
- CUIT / documento fiscal: `cuit`, `cuil`, `taxId`, `docNro`, `documento`
- Actividad / rubro: `actividad`, `rubro`, `industria`, `aQueSeDedican`, `queSeDedican`, `dedicacion`
- Servicio o interes comercial: `servicio`, `necesidad`, `interes`, `tipoActividad`

La app guarda `actividad` en el campo `ca` de la tarjeta y `servicio/interes` en `ta`. En el tablero de Ventas se muestran como `Actividad: ...` e `Interes: ...`.

## Configuracion del nodo HTTP Request en n8n

1. Method: `POST`
2. URL: `https://TU-DOMINIO/api/external/leads/enrich` para solo guardar datos, o `https://TU-DOMINIO/api/external/leads/presupuestar` para guardar y mover a presupuestado.
3. Authentication: `None`
4. Send Headers: `true`
5. Headers:
   - `x-api-key`: tu valor seguro de `EXTERNAL_API_KEY`
   - `Content-Type`: `application/json`
6. Send Body: `true`
7. Body Content Type: `JSON`
8. Body:

```json
{
  "phone": "={{ $json.phone || $json.num || $json.cleanedSenderPn || $json.cleanedSenderPN || '' }}",
  "jid": "={{ $json.jid || $json.remoteJid || '' }}",
  "empresa": "={{ $json.empresa || $json.nombreEmpresa || $json.razonSocial || '' }}",
  "cuit": "={{ $json.cuit || $json.cuil || '' }}",
  "actividad": "={{ $json.actividad || $json.rubro || $json.aQueSeDedican || '' }}",
  "servicio": "={{ $json.servicio || $json.necesidad || $json.interes || '' }}",
  "motivo": "={{ $json.motivo || 'Lead calificado automaticamente' }}"
}
```

Si tu workflow ya tiene el id de la tarjeta, es mejor usar:

```json
{
  "cardId": "={{ $json.cardId }}",
  "empresa": "={{ $json.empresa || $json.nombreEmpresa || $json.razonSocial || '' }}",
  "cuit": "={{ $json.cuit || $json.cuil || '' }}",
  "actividad": "={{ $json.actividad || $json.rubro || $json.aQueSeDedican || '' }}",
  "servicio": "={{ $json.servicio || $json.necesidad || $json.interes || '' }}",
  "motivo": "={{ $json.motivo || 'Lead calificado automaticamente' }}"
}
```

## Paso a paso sugerido en n8n

1. En el nodo del agente, pedile que devuelva JSON cuando el cliente informe datos de empresa. Ejemplo de salida esperada:

```json
{
  "empresa": "ACME SRL",
  "cuit": "30-12345678-9",
  "actividad": "Venta mayorista de indumentaria",
  "servicio": "Automatizacion de atencion por WhatsApp",
  "motivo": "Datos comerciales detectados en la conversacion"
}
```

2. Agrega un nodo **Set** o **Edit Fields** antes del HTTP Request para normalizar:
   - `phone`: el numero limpio del remitente.
   - `jid`: el `remoteJid` si no tenes telefono.
   - `empresa`, `cuit`, `actividad`, `servicio`, `motivo`: desde la respuesta del agente.

Si el HTTP Request esta despues del **AI Agent**, no uses solo `$json`, porque en ese punto `$json` suele ser la salida del agente. Mantene los identificadores con referencias explicitas:

```json
{
  "phone": "={{ $('Edit Fields1').item.json.num || $('Webhook').item.json.body.data.messages.key.cleanedSenderPn || '' }}",
  "jid": "={{ $('Webhook').item.json.body.data.messages.key.remoteJid || $('Webhook').item.json.body.data.messages.remoteJid || '' }}"
}
```

## Correccion exacta para el workflow de la captura

No hace falta agregar nodos para resolver el error actual. Deja la cadena asi:

```txt
Webhook -> Edit Fields1 -> AI Agent -> HTTP Request5 -> Switch
```

Y cambia estos 4 grupos de nodos.

### 1. Nodo Edit Fields1

Objetivo: que el agente tenga memoria por chat. En tu captura `sessionId` esta quedando `null` porque lee `$json.num`, pero `num` se crea en ese mismo nodo y todavia no existe.

Abrir **Edit Fields1** y dejar exactamente estos campos:

```txt
text
={{ $json.body.data.messages.message.conversation || $json.body.data.messages.message.extendedTextMessage?.text || $json.body.data.messages.message.imageMessage?.caption || '' }}
```

```txt
num
={{ $json.body.data.messages.key.cleanedSenderPn || '' }}
```

```txt
sessionId
={{ $json.body.data.messages.key.remoteJid || $json.body.data.messages.remoteJid || $json.body.sessionId || $json.body.data.sessionId || $json.body.data.messages.key.cleanedSenderPn || '' }}
```

No actives **Include Other Input Fields**.

### 2. Nodo HTTP Request5

Objetivo: guardar en la tarjeta los datos que devolvio el agente sin perder el telefono/JID del webhook.

Abrir **HTTP Request5**, que esta entre **AI Agent** y **Switch**.

Configuracion:

```txt
Method: POST
URL: https://app.consultoriadigital.io/api/external/leads/enrich
Authentication: None
Send Headers: true
Specify Headers: Using Fields Below
Header name: x-api-key
Header value: TU_EXTERNAL_API_KEY
Send Body: true
Body Content Type: JSON
Specify Body: Using Fields Below
```

En **Body Parameters**, agrega o reemplaza por estos campos:

```txt
phone
={{ $('Edit Fields1').item.json.num || $('Webhook').item.json.body.data.messages.key.cleanedSenderPn || '' }}
```

```txt
jid
={{ $('Webhook').item.json.body.data.messages.key.remoteJid || $('Webhook').item.json.body.data.messages.remoteJid || '' }}
```

```txt
output
={{ $('AI Agent').item.json.output || '{}' }}
```

```txt
motivo
=Lead enriquecido por n8n
```

No agregues `empresa`, `cuit`, `actividad` ni `servicio` si ya vienen dentro de `output`; el backend los lee desde ahi.

### 3. Nodo Switch

Objetivo: que el ruteo lea la decision del **AI Agent**, no la respuesta de **HTTP Request5**.

Abrir **Switch** y cambiar todas las reglas que usen algo parecido a:

```txt
{{ JSON.parse($json.output || '{}').presupuesto }}
```

o:

```txt
{{ JSON.parse($json.output || '{}').pdf }}
```

por referencias explicitas al agente:

```txt
={{ JSON.parse($('AI Agent').item.json.output || '{}').presupuesto }}
```

Reglas recomendadas segun tus ramas:

```txt
Output 0 - presupuesto is empty
={{ JSON.parse($('AI Agent').item.json.output || '{}').pdf }}
is empty
```

```txt
Output 1 - turneria
={{ JSON.parse($('AI Agent').item.json.output || '{}').presupuesto }}
is equal to
turneria
```

```txt
Output 2 - rrss_pauta
={{ JSON.parse($('AI Agent').item.json.output || '{}').presupuesto }}
is equal to
rrss_pauta
```

```txt
Output 3 - concilia
={{ JSON.parse($('AI Agent').item.json.output || '{}').presupuesto }}
is equal to
concilia
```

```txt
Output 4 - crm_redes
={{ JSON.parse($('AI Agent').item.json.output || '{}').presupuesto }}
is equal to
crm_redes
```

### 4. Nodos finales HTTP Request1, HTTP Request2, HTTP Request3 y HTTP Request4

Objetivo: marcar la tarjeta como presupuestada despues de enviar el documento.

Abrir cada uno de estos nodos finales:

```txt
HTTP Request1
HTTP Request2
HTTP Request3
HTTP Request4
```

Verificar que llamen a:

```txt
https://app.consultoriadigital.io/api/external/leads/presupuestar
```

Si alguno llama a `/api/external/leads/enrich`, cambiarlo a `/api/external/leads/presupuestar`.

En el body de cada uno, agregar o reemplazar estos campos:

```txt
phone
={{ $('Edit Fields1').item.json.num || $('Webhook').item.json.body.data.messages.key.cleanedSenderPn || '' }}
```

```txt
jid
={{ $('Webhook').item.json.body.data.messages.key.remoteJid || $('Webhook').item.json.body.data.messages.remoteJid || '' }}
```

```txt
output
={{ $('AI Agent').item.json.output || '{}' }}
```

```txt
motivo
=Presupuesto enviado por WhatsApp
```

Con esto no necesitas tocar los nodos de envio de WhatsApp ni los nodos de archivos.

### 5. Prueba rapida

Ejecuta el workflow con un mensaje como:

```txt
me mandas de nuevo el presupuesto?
```

Resultado esperado:

- **HTTP Request5** responde `ok: true`, `action: update` o `noop`; no debe devolver error 400.
- **Switch** entra en la rama correcta segun `presupuesto`.
- Se envia el PDF por WhatsApp.
- El HTTP final responde `ok: true`.
- En la app, la tarjeta queda enriquecida y/o movida a `presupuestado`.

## Respuestas esperadas

`action: "update"`: la tarjeta estaba en `contactado` y paso a `presupuestado`.

`action: "update"` tambien puede aparecer si la tarjeta ya estaba en ese estado, pero se enriquecio con empresa/CUIT/actividad.

`action: "noop"`: la tarjeta ya estaba en `presupuestado`.

`action: "skipped"`: la tarjeta existe, pero no estaba en `contactado`; la app no la movio.

`404`: no se encontro tarjeta para ese `phone`, `jid` o `cardId`.

## Endpoint generico disponible

Tambien queda disponible el endpoint generico:

```txt
POST /api/external/cards/update-status
```

Body:

```json
{
  "phone": "5491123456789",
  "estado": "presupuestado",
  "fromEstado": "contactado",
  "motivo": "Lead calificado por n8n"
}
```

Usalo solo si despues necesitas mover leads a otros estados desde n8n. Para el flujo actual, usa `/api/external/leads/presupuestar`.
