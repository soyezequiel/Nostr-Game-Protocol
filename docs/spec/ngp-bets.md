# NGP — Apuestas: escrow transparente por eventos

> **Estado: estable (v1).** Los kinds 1339 / 1341 / 31340 están **congelados** y
> validados en producción con sats reales. Extiende [ngp.md](ngp.md).
>
> Implementación de referencia del wire: [`src/ngp-core.ts`](../../src/ngp-core.ts)
> provee el template del resultado (`buildBetResultTemplate`, kind:1341). Los
> helpers de estado del escrow (31340) y de parseo del contrato (1339) se
> removieron del SDK; el escrow que los implemente arma esos eventos por su cuenta.
> Implementación de referencia del escrow: Luna Negra.

## 0. La restricción honesta: custodio sí, pero transparente

Retener un stake y pagar al ganador exige un **custodio** (trustless real =
DLCs sobre Bitcoin, fuera de alcance). Lo que esta spec cambia es el contrato
social con ese custodio: deja de ser un servidor con API propietaria y pasa a
ser un **escrow transparente** — todas sus acciones son eventos firmados,
públicos y verificables por cualquier cliente Nostr.

**Qué garantiza:** detectabilidad, no imposibilidad. Si el escrow no paga o
paga mal, la cadena de eventos lo prueba públicamente (§7). Es una garantía
reputacional, no criptográfica — y la spec no lo esconde.

**Quién puede ser escrow:** cualquiera. El contrato declara la pubkey del
escrow; el rol no pertenece a ninguna plataforma por definición.

## 1. Rangos de kind — por qué estos números

- **Contrato (1339) y resultado (1341)**: eventos **regulares** (1000–9999),
  porque DEBEN ser inmutables. En rango addressable un segundo evento del mismo
  autor reemplazaría al contrato — inaceptable.
- **Estado del escrow (31340)**: **addressable** (`d` = id del contrato),
  porque es el único que debe ser reemplazable: representa el estado vigente.
- El `id` del contrato **es** el hash de los términos: integridad gratis del
  protocolo.

## 2. El contrato — `kind:1339`

Lo firma y publica el **retador** (un jugador, o el juego en su nombre). El
contrato existe y es verificable sin ninguna plataforma.

```jsonc
{
  "kind": 1339,
  "pubkey": "<pubkey del retador>",
  "created_at": 1751760000,
  "tags": [
    ["a", "30023:79be…f817:tetra"],                 // GAME — coordenada NIP-23
    ["p", "<pubkey jugador 1>"],                    // p sin rol = participante (1 por asiento)
    ["p", "<pubkey jugador 2>"],
    ["p", "<pubkey escrow>", "<relay>", "escrow"],  // rol: quién custodia
    ["p", "<pubkey oráculo>", "<relay>", "oracle"], // rol: quién declara ganador
    ["stake", "1000"],                              // sats por asiento, entero
    ["deadline", "1751763600"],                     // unix: límite para fondear
    ["room", "sala-8f21"],                          // opcional: sala donde se juega
    ["t", "ngp-bet"]                                // descubrimiento
  ],
  "content": "Apuesta 1v1 en TETRA. Gana el mejor de 3."   // condición de victoria, texto libre
}
```

### Reglas normativas

- Un `p`-tag es **de rol** si lleva el token `escrow` u `oracle` después de la
  pubkey (en la posición del relay hint o del marker, estilo NIP-10). Los `p`
  sin rol son **participantes**, uno por asiento, en orden. El retador PUEDE
  ser también participante (lo normal en 1v1).
- `stake`: sats enteros por asiento, igual para todos, dentro de los límites
  publicados por el escrow (§2.1).
- `deadline`: **NO usar** el tag `expiration` de NIP-40 — los relays pueden
  borrar el evento vencido y el contrato debe sobrevivir como registro.
- El tag `t`=`ngp-bet` DEBE estar presente (descubrimiento y filtrado).
- Asientos invitados: todo asiento es una pubkey. Para invitados sin identidad,
  el juego genera una **clave efímera** por invitado, no reutilizable entre
  apuestas, y firma con ella el depósito. Quien pierde la clave antes del
  payout pierde el acceso automático al premio (queda el retiro manual que
  ofrezca el escrow).
- Comentarios y zaps sociales cuelgan del contrato (`e`=id) y del juego
  (`a`=GAME) con NIPs estándar.

### 2.1 Condiciones del escrow — publicadas, no negociadas

El escrow publica sus comisiones y límites como evento addressable, para que
el juego los lea **antes** de crear el contrato:

```jsonc
{
  "kind": 31340,
  "pubkey": "<pubkey escrow>",
  "tags": [
    ["d", "terms"],
    ["t", "ngp-bet"]
  ],
  "content": "{\"minStakeSats\":100,\"maxStakeSats\":100000,\"feePct\":2,\"devFeeMaxPct\":1,\"feeMinSats\":1,\"maxSeats\":8,\"depositWindowSec\":3600,\"resolveWindowSec\":86400,\"withdrawWindowSec\":604800}"
}
```

No hay negociación: el escrow **acepta o rechaza** cada contrato con su primer
evento de estado (§4). Si el stake está fuera de rango o el juego no le consta,
publica `status=rejected` con el motivo y ahí termina.

## 3. Depósito = aceptación — NIP-57 estándar

No existe un evento de aceptación: el **zap request (`kind:9734`) firmado** por
cada participante es su firma sobre los términos.

1. El participante firma un 9734 con `["e", "<id del contrato>"]`,
   `["p", "<pubkey escrow>"]` y `amount` = stake en msat.
2. Lo manda al callback LNURL-pay del escrow (descubierto del `kind:0`/lud16
   del escrow, como cualquier zap).
3. Paga el invoice `pr` que recibe.
4. El escrow publica el **recibo `kind:9735`**: prueba pública del depósito,
   con el 9734 embebido (la firma del participante queda dentro del recibo).

El escrow DEBE validar antes de emitir invoice: el firmante del 9734 es un
asiento del contrato, el monto es exactamente el stake, el contrato no venció
ni fue rechazado, y el asiento no está ya fondeado.

> **Anti-spam por diseño:** el escrow NO necesita reaccionar a cada 1339 que lo
> nombre. PUEDE ignorar contratos hasta el **primer intento de depósito** (el
> callback LNURL trae el 9734 con el `e` del contrato → lo busca en relays
> on-demand, lo valida y recién ahí crea estado). Publicar contratos basura es
> gratis e inofensivo; fondearlos cuesta sats.

Opcional: el participante PUEDE publicar un **comentario de participación**
(`kind:1111`, NIP-22, con `E`/`e`=contrato) para que el premio se zapee a ese
comentario y quede en su perfil.

## 4. Estado del escrow — `kind:31340`

Lo firma el **escrow**. Addressable con `d` = id del contrato: siempre hay un
único estado vigente y cada transición queda firmada y con timestamp. Reemplaza
el polling de una API por una suscripción.

```jsonc
{
  "kind": 31340,
  "pubkey": "<pubkey escrow>",
  "created_at": 1751761000,
  "tags": [
    ["d", "<id del contrato>"],
    ["e", "<id del contrato>"],            // navegable desde el contrato
    ["a", "30023:79be…f817:tetra"],
    ["status", "funded"],
    ["bet", "<id interno del escrow>"],    // correlación, opaco
    ["t", "ngp-bet"]
  ],
  "content": "{\"betId\":\"…\",\"status\":\"funded\",\"stakeSats\":1000,\"seats\":2,\"participants\":[\"<pk1>\",\"<pk2>\"],\"feePct\":2,\"devFeePct\":1,\"deposits\":[{\"p\":\"<pk1>\",\"receipt\":\"<id 9735>\"},{\"p\":\"<pk2>\",\"receipt\":\"<id 9735>\"}]}"
}
```

| `status` | Significado |
|---|---|
| `accepted` | contrato validado, esperando depósitos |
| `rejected` | el escrow no toma este contrato (motivo en content) |
| `funded` | todos los asientos depositaron; a jugar |
| `resolved` | pagado; el content referencia el 1341 (`resultEvent`) y los 9735 de payout |
| `void` | anulada; depósitos reembolsados (recibos en content) |
| `expired` | venció `deadline` sin fondear; depósitos parciales reembolsados |

En `resolved` el content enlaza toda la liquidación: `resultEvent` (id del
1341), `payouts` (recibos del premio y del corte del dev) y las comisiones
retenidas. **Toda la apuesta queda auditable desde un solo evento.**

Suscripción del juego: `{ "kinds": [31340], "#e": ["<id del contrato>"] }`.

## 5. El resultado — `kind:1341`

Lo firma el **oráculo** declarado en el contrato. Regular e inmutable: la
autenticación ES la firma.

```jsonc
{
  "kind": 1341,
  "pubkey": "<pubkey del oráculo>",
  "created_at": 1751764000,
  "tags": [
    ["e", "<id del contrato>"],
    ["a", "30023:79be…f817:tetra"],
    ["p", "<pubkey ganador>"],             // 0..N ganadores
    ["status", "win"],                     // win | draw | void
    ["t", "ngp-bet"]
  ],
  "content": "{\"score\":\"3-1\"}"         // opcional, metadata libre
}
```

- **`win`** + 1..N `p` = reparto del pozo entre ganadores (menos comisiones).
- **`draw`** (sin `p`) = empate: el pozo vuelve por partes iguales.
- **`void`** = anulación con reembolso. También PUEDE firmarlo el **retador**
  (el firmante del 1339) mientras nadie haya fondeado — equivale a cancelar.

El escrow, antes de pagar, DEBE verificar: firma válida; `pubkey` == oráculo
del contrato; `e` == contrato en estado `funded`; ganadores ⊆ participantes; y
que no exista ya un 1341 procesado para ese contrato (**el primero válido
gana**; los siguientes se ignoran — idempotencia).

Si vence la ventana de resolución sin 1341 (el oráculo murió), el escrow anula
y reembolsa, publicando `status=void` en el 31340 con el motivo.

### Quién es el oráculo (y el hueco TOFU)

El 1341 se valida contra el `oracle` que declara el **propio contrato**. No hay
registro previo: el contrato es la fuente (confianza al primer uso).

> **⚠️ Seguridad (TOFU).** Cualquiera puede publicar un 1339 para un juego
> declarando SU oráculo. Si engaña a una víctima a depositar en ese contrato,
> el atacante firma el 1341 y cobra. Mitigaciones: (a) el jugador solo deposita
> en contratos que le muestra su juego de confianza; (b) el artículo 30023 del
> juego PUEDE declarar el oráculo legítimo (`["oracle", <pk>]`) y un verificador
> PUEDE exigir que coincida; (c) el escrow PUEDE exigir que el contrato lo
> nombre a él como `escrow`. Un modelo con registro por juego cierra el hueco a
> cambio de perder el "sin registro".

### Relación con el marcador

El `kind:31339` (score del jugador) sigue siendo social y falsificable — nunca
dispara pagos. El 1341 es la pieza con dinero; la atestación 31338 es su prima
sin dinero (el oráculo puede publicar ambos).

## 6. Payouts — zaps

- **Premio**: zap del escrow al ganador (al 1111 de participación si existe,
  si no profile-zap). Recibo 9735 público.
- **Corte del dev**: zap a la Lightning Address del proveedor. Recibo 9735.
- **Corte de la casa**: se retiene en el pozo; queda declarado en el content
  del 31340 `resolved`.

## 7. Verificación por terceros — la cadena completa

Cualquier cliente Nostr, sin tocar al escrow, puede reconstruir y auditar una
apuesta:

1. **Contrato** (1339): firmado por el retador; su `id` fija los términos.
2. **Oráculo legítimo**: el `oracle` del contrato coincide con el del artículo
   30023 del juego.
3. **Depósitos**: recibos 9735 del escrow con `e`=contrato; cada uno embebe el
   9734 firmado por el participante (su aceptación).
4. **Estado**: transiciones 31340 firmadas y con timestamp.
5. **Resultado**: 1341 firmado por el oráculo declarado.
6. **Payouts**: 9735 del premio y del corte del dev; los montos deben cuadrar
   con `stake × asientos − comisiones` publicadas en `terms`.

Si el escrow paga a quien el 1341 no declaró, no paga, o los montos no cuadran,
cualquiera puede probarlo con eventos firmados.

### Amenazas consideradas

| Amenaza | Mitigación |
|---|---|
| Alterar términos post-firma | imposible: el `id` del 1339 es el hash |
| Resultado falso | solo vale la firma del oráculo declarado; el 31339 nunca paga |
| Clave del oráculo comprometida | rotación: re-publicar el 30023 con la nueva |
| Replay de un 1341 en otro contrato | el tag `e` lo ata a un contrato único |
| Reuso de un 9734 viejo | el invoice compromete el 9734 vía description hash (NIP-57) |
| Spam de contratos | el escrow no hace nada hasta el primer intento de depósito (§3) |
| Doble 1341 contradictorio | el primero válido gana; idempotente |
| Relay censura/pierde eventos | publicar a varios relays; el camino LNURL garantiza que el escrow vea todo contrato que alguien intenta fondear |
| Contrato TOFU malicioso | ver "Quién es el oráculo" (§5) |

## 8. Checklist para el dev de un juego

```
1. Leer terms del escrow   → 1 fetch  {kinds:[31340], "#d":["terms"], authors:[escrow]}
2. Publicar el contrato    → firmar y publicar 1 evento kind:1339
3. Depositar               → cada participante firma su 9734 + LNURL-pay estándar
4. Seguir el estado        → 1 suscripción {kinds:[31340], "#e":[contrato]}
5. Reportar el ganador     → firmar y publicar 1 evento kind:1341 (server)
```

Sin API key, sin polling, sin backend salvo la clave del oráculo. Quien
prefiera coordinación privada RPC usa [NGE](nge.md); la liquidación pública de
este documento es la misma.
