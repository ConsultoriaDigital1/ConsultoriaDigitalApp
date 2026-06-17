# Integracion n8n: mover leads a Presupuestado

## Objetivo

Cuando n8n detecte que un lead cumple la condicion definida en el workflow, debe llamar a la app para mover la tarjeta de Ventas desde `contactado` hacia `presupuestado`.

## Metodo recomendado

Usar un nodo **HTTP Request** de n8n con metodo **POST**.

Endpoint recomendado:

```txt
POST https://TU-DOMINIO/api/external/leads/presupuestar
```

En local:

```txt
POST http://localhost:3000/api/external/leads/presupuestar
```

Este endpoint es especifico para este caso:

- Busca la tarjeta por `cardId` o por telefono.
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

Buscar por telefono:

```json
{
  "phone": "5491123456789",
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

## Configuracion del nodo HTTP Request en n8n

1. Method: `POST`
2. URL: `https://TU-DOMINIO/api/external/leads/presupuestar`
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
  "phone": "={{ $json.phone }}",
  "motivo": "={{ $json.motivo || 'Lead calificado automaticamente' }}"
}
```

Si tu workflow ya tiene el id de la tarjeta, es mejor usar:

```json
{
  "cardId": "={{ $json.cardId }}",
  "motivo": "={{ $json.motivo || 'Lead calificado automaticamente' }}"
}
```

## Respuestas esperadas

`action: "update"`: la tarjeta estaba en `contactado` y paso a `presupuestado`.

`action: "noop"`: la tarjeta ya estaba en `presupuestado`.

`action: "skipped"`: la tarjeta existe, pero no estaba en `contactado`; la app no la movio.

`404`: no se encontro tarjeta para ese `phone` o `cardId`.

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
