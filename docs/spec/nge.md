# NGE — Nostr Game Escrow (canal de coordinación)

> **Estado: estable (v1.1, aditiva sobre v1.0).** En producción.
>
> Implementación de referencia del wire: [`src/nge-core.ts`](../../src/nge-core.ts)
> (kinds, URI, cifrado, templates). Cliente de referencia:
> [`src/nge-client.ts`](../../src/nge-client.ts). Conformidad:
> [test vectors](../../vectors/) firmados con claves y nonce fijos.

NGE es **solo el canal de coordinación** entre un juego y un escrow: un RPC
request/response cifrado, calcado de [NWC / NIP-47](https://github.com/nostr-protocol/nips/blob/master/47.md).
No define qué se publica en Nostr — eso es [NGP-apuestas](ngp-bets.md), una
capacidad que el escrow declara (`get_info.transparency`) y el juego modula por
apuesta (`create_bet.visibility`).

## 1. Modelo

- El **escrow** tiene una pubkey estable `S`, publicada en la URI de conexión.
- El **juego** tiene una clave de cliente `C` (el `secret` de la URI),
  autorizada por el escrow al emitir la credencial.
- La coordinación viaja como eventos **efímeros** cifrados **NIP-44**. El relay
  es un caño tonto: transporta, no guarda.
- **La fuente de verdad vive en el escrow** (su DB), no en los relays. La
  coordinación es privada; la liquidación pública (formato NGP) es opcional y
  auditable.

**Garantías:** coordinación privada; autenticación bidireccional (el juego
prueba ser la `C` autorizada, el escrow firma toda response con `S`); destinos
acotados (los payouts solo van a los destinos declarados en `create_bet` — una
`C` comprometida puede *elegir* ganador, no redirigir fondos). **No es
trustless:** custodia = tercero de confianza.

## 2. Roles

| Rol | Clave | Qué hace |
|---|---|---|
| **Escrow** | `S` (en la URI) | custodia el pozo, fuente de verdad, emite invoices, paga, reembolsa; firma toda response |
| **Juego** | `C` (`secret` de la URI) | orquesta apuestas y **es el oráculo** (reporta resultados); una `C` por juego |
| **Jugadores** | pubkey Nostr (recomendado) o anónimo | pagan el bolt11 de su asiento; **no firman nada** |

## 3. URI de conexión

```
nostr+nge://<S-pubkey>?relay=wss://relay.example&secret=<C-secret>
```

- `S-pubkey` (host): pubkey del escrow (hex o npub). Hacia ella se cifra; con
  ella se verifica toda response.
- `relay` (1+): transporte.
- `secret`: clave del cliente `C` (nsec o 32 bytes hex).

Esos 3 campos son TODO: la config (límites, fees, métodos) se pide por
`get_info`.

## 4. Transporte y cifrado

request / response / notification = eventos Nostr **efímeros** con `content` =
JSON cifrado **NIP-44** entre `C` y `S`.

| Kind | Qué | Firma | Tags | NWC análogo |
|---|---|---|---|---|
| `24940` | request | `C` | `["p", S]` (+ `["expiration", ts]` opcional) | 23194 |
| `24941` | response | `S` | `["p", C]`, `["e", <id del request>]` | 23195 |
| `24942` | notification | `S` | `["p", C]` (sin `e`) | 23196/23197 |

Payload descifrado del request: `{ "method": "…", "params": { … } }`.
De la response: `{ "result_type": "…", "result": { … } }` o
`{ "result_type": "…", "error": { "code": "…", "message": "…" } }`.

### Ejemplo — request `get_bet` (antes de cifrar)

```jsonc
// payload en claro (va cifrado NIP-44 en content):
{ "method": "get_bet", "params": { "betId": "bet_8f21" } }

// evento publicado:
{
  "kind": 24940,
  "pubkey": "<C-pubkey>",
  "created_at": 1751760000,
  "tags": [["p", "<S-pubkey>"]],
  "content": "<NIP-44 ciphertext>"
}
```

## 5. Autenticación, anti-replay y entrega

- El escrow acepta un request solo si lo firma una `C` **autorizada**; el juego
  acepta una response solo si la firma `S`.
- **Anti-replay:** id de evento único + `created_at` en ventana de frescura;
  el escrow **deduplica por id** y cachea la response (reenviar el mismo evento
  firmado es seguro y es el mecanismo at-least-once sobre relay efímero).
- **Idempotencia por clave natural:** `report_result` y `cancel_bet` por
  `betId`; `create_bet` por `clientRef` (dos `create_bet` con el mismo
  `clientRef` devuelven el mismo `betId`).
- **Revocación de `C`:** estado interno del escrow (no hay evento público);
  request de una `C` revocada → `UNAUTHORIZED`. Recuperarse = credencial nueva.

## 6. Métodos

### `get_info`
→ `{ methods, version, currency: "sat", minStakeSats, maxStakeSats, feePct, devFeePct, transparency, visibilityOptions, notifications?, limits?, settleDelaySec?, settleDelayMinPotSats? }`

- `transparency`: `"public"` = el escrow liquida en Nostr con eventos públicos
  auditables (formato NGP: 31340 + 1341 + 9735); `"none"` = solo coordinación
  privada. El juego decide con esta información **antes** de mandar plata.
- `notifications` *(v1.1)*: tipos de 24942 que emite (`["bet_updated"]`);
  ausente = solo polling.
- `limits` *(v1.1)*: `{ createBetPerMin, maxPendingBets }`; excederlos →
  `RATE_LIMITED`.
- `settleDelaySec` / `settleDelayMinPotSats` *(v1.1)*: ventana de disputa (§7).

### `create_bet`
`params`: `{ seats: [{ seatId, pubkey?, payoutAddress? }], stakeSats, condition?, deadlineSec?, clientRef?, roomId?, visibility? }`
→ *(v1.1)* el detalle completo (mismo shape que `get_bet`) **más**
`deposits: [{ seatId, bolt11, amountSats, expiresAt }]` — un solo RPC deja al
juego listo para mostrar los QR.

- `stakeSats` es **por asiento**; pozo objetivo = `stakeSats × seats.length`.
- `visibility`: `"public"` (default) | `"unlisted"` (omite la sombra 31340 de
  esa apuesta; solo válido si `get_info.visibilityOptions` lo anuncia).

### `get_bet` — la fuente de verdad; de esto se hace polling
`params`: `{ betId }`
→ `{ betId, status, stakeSats, potSats, deadlineSec, seats: [{ seatId, deposited, bolt11?, payout? }], result? }`

- `status`: `pending_deposits | funded | resolving | settled | cancelled | expired | refunded`.
- Para asientos sin pagar devuelve un `bolt11` **vigente** (re-emitido si venció).

### `report_result` — solo el juego (oráculo)
`params`: `{ betId, winners: [seatId] }` (vacío = empate/anulación → reembolso)
→ `{ ok, status, settleAt? }`

- Solo válido con `status = funded` (`NOT_FUNDED` si no).
- `winners` ⊆ asientos fondeados (`BAD_WINNER` si no).
- **Finalidad idempotente:** el primer `report_result` válido fija el
  resultado; un reintento idéntico devuelve la response cacheada; uno distinto
  sobre `resolving/settled` → `ALREADY_SETTLED`.
- Reparto: pozo neto = `potSats − fees`, partes iguales entre `winners`; resto
  indivisible al primero. `winners` vacío = cada asiento recupera su stake.

### `cancel_bet`
`params`: `{ betId }` → `{ ok, status }`. Solo pre-fondeo (`NOT_CANCELLABLE`
después); una vez `funded`, la única salida es `report_result`.

### Ventana de disputa *(v1.1, opcional)*

Acota el daño de una `C` comprometida sobre apuestas en vuelo. Si
`potSats ≥ settleDelayMinPotSats`, el primer `report_result` fija el resultado
pero **difiere el payout** hasta `settleAt = ahora + settleDelaySec` (estado
`resolving`). Durante la ventana solo el operador del escrow puede intervenir
(anular → reembolso). No hay método RPC de objeción: la disputa es capa
producto.

### Códigos de error

`UNAUTHORIZED`, `NOT_FOUND`, `NOT_FUNDED`, `ALREADY_SETTLED`, `BAD_WINNER`,
`NOT_CANCELLABLE`, `STAKE_OUT_OF_RANGE`, `EXPIRED_REQUEST`, `RATE_LIMITED`
*(v1.1)*, y los específicos de la implementación del escrow (p. ej.
`SELF_SIGNED_ORACLE` cuando el escrow no custodia la clave del oráculo del
contrato y el juego debe firmar su propio 1341).

## 7. Depósitos y payouts

- **Depósitos:** `bolt11` plano por asiento, emitido por el nodo del escrow
  (sin zap). El pago no es un evento público; los asientos y el stake sí
  quedan públicos si la liquidación es transparente.
- Todo pago que llega cuando el asiento ya está pagado o la apuesta terminó
  **no entra al pozo: se reembolsa a su origen**.
- **Payouts — cascada por capacidad del destino del ganador:** lud16 con
  NIP-57 → zap social 9735 (tag `["nge","payout"]`, anclado al contrato);
  dirección Lightning sin zaps → pago LNURL plano; nada → retiro por QR.
  El tag `nge-payout` permite renderizarlo como "ganó una apuesta" y excluir
  al escrow de los rankings de zappers.

## 8. Push — notification `bet_updated` *(v1.1)*

En cada transición observable el escrow publica un `kind:24942` cifrado hacia
la `C` dueña. Payload:

```jsonc
{ "notification_type": "bet_updated",
  "notification": { "betId": "bet_8f21", "status": "funded", "deposited": ["alice", "bob"] } }
```

Es **best-effort y no autoritativo**: despierta al cliente, que confirma con
`get_bet`. El polling sigue siendo el respaldo (clientes serverless usan solo
`get_bet` periódico).

## 9. Versionado

`get_info.version` anuncia la versión. Los kinds efímeros quedan congelados;
cambios incompatibles → bump de `version` + método nuevo, no reescritura de
kinds. **v1.1** (2026-07, aditiva): detalle completo en `create_bet`,
notification 24942, `RATE_LIMITED`/`limits`, ventana de disputa.

## Apéndice — flujo de una apuesta 1v1

```
Juego (C)                            Escrow (S)                     Jugadores
  │  create_bet {seats, stake} ────▶  │
  │  ◀── detalle completo + deposits  │   (un solo RPC: QRs + estado inicial)
  │  (muestra el QR a cada jugador)   │◀──── paga su bolt11 ────────── A, B
  │  ◀── 24942 bet_updated (push)     │  (detecta pagos; push best-effort)
  │  get_bet (confirma / respaldo) ─▶ │
  │  ◀── {status: funded}             │
  │        …se juega la partida…      │
  │  report_result {winners:[A]} ──▶  │  liquida, paga a A, fee interna
  │  ◀── {ok, status, settleAt?}      │  (pozo grande → ventana de disputa)
  │  ◀── 24942 bet_updated (settled)  │  ── zap social a A si tiene lud16 ──▶ feed
```
