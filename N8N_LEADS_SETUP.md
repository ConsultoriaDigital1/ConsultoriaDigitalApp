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
- `senderPn`
- `senderPN`
- `senderPhone`
- `data.messages.key.cleanedSenderPN`
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
  "phone": "={{ $json.phone || $json.cleanedSenderPN || '' }}",
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

3. En el nodo **HTTP Request**, usa `POST /api/external/leads/enrich` con el header `x-api-key` cuando solo quieras guardar datos.

4. Cuando el workflow determine que ya corresponde presupuestar, usa otro HTTP Request a `POST /api/external/leads/presupuestar` con el mismo body. Ese endpoint tambien actualiza los datos y mueve el lead si estaba en `contactado`.

5. Proba con un lead real: despues de ejecutar el workflow, la tarjeta debe mostrar empresa como titulo si venia con nombre automatico de WhatsApp, CUIT arriba a la derecha y `Actividad: ...` en el cuerpo.

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
