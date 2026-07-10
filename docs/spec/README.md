# Nostr Games Protocol — Especificación

**Este directorio es la fuente canónica de la especificación.** Lo que dice acá
define el protocolo; todo lo demás (Luna Negra, Tetris, este mismo SDK) son
*implementaciones* que se ajustan a estos documentos. Si una implementación y
esta spec difieren, gana la spec — o se corrige la spec con un cambio
deliberado y versionado.

| Documento | Qué define |
| --- | --- |
| [ngp.md](ngp.md) | **NGP** — la capa pública: identidad, coordenada del juego, marcador (`kind:31337`), atestación de oráculo (`kind:31338`), presencia (NIP-38), reto 1v1 (NIP-17) |
| [ngp-bets.md](ngp-bets.md) | **NGP-apuestas** — escrow transparente por eventos: contrato (`kind:1339`), resultado (`kind:1341`), estado del escrow (`kind:31340`), depósitos y payouts por zaps (NIP-57) |
| [nge.md](nge.md) | **NGE** — el canal privado de coordinación con el escrow: RPC cifrado NIP-44 sobre eventos efímeros (`24940`/`24941`/`24942`), estilo NWC |
| [../nip/games.md](../nip/games.md) | **Draft de NIP** (inglés) — la propuesta para `nostr-protocol/nips` |

## Los dos protocolos, en una línea

- **NGP** publica: todo lo que conviene que sea público y verificable por
  cualquier cliente Nostr (marcadores, presencia, contratos, resultados,
  estado del escrow, payouts).
- **NGE** coordina: el RPC privado entre un juego y un escrow (crear apuesta,
  consultar, reportar resultado). El relay es un caño tonto; la fuente de
  verdad vive en el escrow.

Se complementan: NGE coordina en privado, NGP publica lo que la apuesta decida
hacer público.

## Tabla de kinds

| Kind | Qué | Firma | Tipo | Origen | Estado |
|---|---|---|---|---|---|
| 0 | Perfil del jugador | jugador | reemplazable | NIP-01 | estándar |
| 1 | Reseñas / comentarios / logros (tag `a`=GAME) | cualquiera | regular | NIP-01 | estándar |
| 13 / 1059 | Seal / gift-wrap del reto 1v1 | remitente / efímera | NIP-59 | NIP-17/59 | estándar |
| 14 | Rumor del reto 1v1 (sin firmar) | — | NIP-59 | NIP-17 | estándar |
| 1111 | Comentario de participación en apuesta | participante | comentario | NIP-22 | estándar |
| 1339 | **Contrato de apuesta** | retador | regular (inmutable) | [ngp-bets](ngp-bets.md) | **estable (v1, congelado)** |
| 1341 | **Resultado / anulación de apuesta** | oráculo | regular (inmutable) | [ngp-bets](ngp-bets.md) | **estable (v1, congelado)** |
| 9734 / 9735 | Zap request / recibo (depósitos, premios) | participante / escrow | NIP-57 | NIP-57 | estándar |
| 10050 | Relays de DM del destinatario | jugador | reemplazable | NIP-17 | estándar |
| 24940 | **NGE request** (RPC cifrado) | cliente `C` | efímero | [nge](nge.md) | **estable (v1.1)** |
| 24941 | **NGE response** | escrow `S` | efímero | [nge](nge.md) | **estable (v1.1)** |
| 24942 | **NGE notification** (`bet_updated`) | escrow `S` | efímero | [nge](nge.md) | **estable (v1.1)** |
| 30023 | Artículo del juego (define la coordenada) | dev | addressable | NIP-23 | estándar |
| 30315 | Presencia "jugando X" | jugador | addressable | NIP-38 | estándar |
| 31337 | **Mejor puntaje del jugador** | jugador | addressable | [ngp](ngp.md) | **estable (congelado)** |
| 31338 | **Atestación de oráculo** | oráculo | addressable | [ngp](ngp.md) | **estable (congelado)** |
| 31340 | **Estado del escrow / terms** | escrow | addressable | [ngp-bets](ngp-bets.md) | **estable (v1, congelado)** |

> **Nota sobre los números.** Los kinds propios (1339, 1341, 31337, 31338,
> 31340, 24940–24942) están congelados porque hay eventos en producción.
> **⚠️ Colisión confirmada (2026-07): `kind:31337` es "Audio Track" de facto**
> (Zapstr/Stemstr/Wavlake, registrado en `registry-of-kinds`) — hay una
> renumeración pendiente antes de proponer el NIP (candidato: 31339), como v2
> del wire con período de doble lectura, nunca un cambio silencioso. Detalle y
> plan: [../nip/roadmap.md](../nip/roadmap.md).

## Niveles de adopción

La spec es un menú. Implementá hasta donde te sirva; cada bloque es independiente.

| Nivel | Qué incluye | Documento |
|---|---|---|
| **N0 — Identidad** | Login NIP-07/NIP-46; la pubkey es el `playerId` | [ngp §1](ngp.md) |
| **N1 — Marcador** | Evento de score 31337 (+ atestación 31338 opcional) | [ngp §2–3](ngp.md) |
| **N2 — Social** | Presencia NIP-38, reto 1v1 NIP-17, reseñas/logros kind:1 | [ngp §4–6](ngp.md) |
| **N3 — Económico** | Zaps NIP-57; apuestas por eventos o por NGE | [ngp-bets](ngp-bets.md), [nge](nge.md) |

## Conformidad

- Los [test vectors](../../vectors/) de este repo son el criterio de
  conformidad para NGE: eventos firmados con claves y nonce fijos que cualquier
  implementación correcta reproduce byte a byte.
- Los parsers/templates de `src/ngp-core.ts` y `src/nge-core.ts` son la
  implementación de referencia del wire — el paquete npm que consumen la tienda
  y los juegos.

## Implementaciones conocidas

| Implementación | Rol | Qué habla |
|---|---|---|
| [Luna Negra](https://github.com/soyezequiel/luna-negra) | tienda / escrow / oráculo gestionado | NGP completo + NGE (lado servidor) |
| [Tetris para Luna Negra](https://github.com/soyezequiel/tetris-para-luna-negra) | juego | NGP (score, atestación, presencia, retos, contratos 1339, oráculo BYO) + NGE (cliente) |
| Este SDK (`nostr-game-protocol`) | librería | wire de referencia + cliente NGE + helpers de firma |

## Historial de cambios de wire

Los cambios de wire son eventos raros y deliberados. Cada uno queda registrado acá:

- **2026-07** — kind:31338 (atestación de oráculo) pasa a estable.
- **2026-07** — NGE v1.1 (aditiva): `create_bet` devuelve detalle completo, notification 24942, `RATE_LIMITED`/`limits`, ventana de disputa.
- **2026-07** — kinds 1339/1341/31340 congelados (v1 estable) tras validación en producción.
