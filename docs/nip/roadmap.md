# Camino al NIP — sistematización

> Plan de trabajo para llevar NGP de "protocolo de un ecosistema" a "NIP con
> credibilidad". Basado en investigación del 2026-07-09 sobre
> `nostr-protocol/nips`, el registro oficial de kinds y los proyectos de gaming
> sobre Nostr activos. Cada afirmación tiene fuente; lo no verificado está
> marcado.

## 1. Por qué un NIP

Un NIP da credibilidad y estimula la adopción: quien lo implementa sabe que el
resto lo está haciendo. Sin NIP, el protocolo queda aislado como "el formato de
una tienda". El precedente directo existe: **NIP-64 (Chess/PGN)** es un juego
de nicho y se mergeó ([PR #1094](https://github.com/nostr-protocol/nips/pull/1094))
porque tenía **dos implementaciones reales** (JesterUI + Brostr) y años de uso.

**Criterios de aceptación** (texto del README de `nostr-protocol/nips`):
implementado en **al menos 2 clientes y 1 relay — "cuando aplique"**; que tenga
sentido; opcional y retrocompatible; una sola forma de hacer cada cosa. Para
NGP el relay no aplica (no requiere lógica de relay especial), pero **hacen
falta dos clientes interoperables** — hoy tenemos Tetris + Luna Negra del mismo
autor; hace falta una implementación independiente.

## 2. El espacio está genuinamente vacío

Confirmado: **no existe ningún NIP mergeado de scores, leaderboards, retos,
apuestas o escrow** (búsqueda de PRs por título: "leaderboard" → 0, "bet" → 0,
"game" → solo NIP-64). Lo más cercano:

- **NIP-64** — solo representación de partida de ajedrez (PGN). No define retos, relojes, apuestas ni rankings.
- **NIP-58 (badges)** — lo que THNDR usó como "Gaming Graph" (logros/reputación).
- **NIP-38 (user statuses)** — dice explícitamente que otros tipos de estado son válidos: nuestra presencia "jugando X" es una extensión compatible, casi ni necesita NIP.
- **Escrow**: tema con historial de fricción — [PR #1714 Catallax](https://github.com/nostr-protocol/nips/pull/1714) (abierto 18 meses sin merge), [PR #2334](https://github.com/nostr-protocol/nips/pull/2334) (cerrado sin merge). Lección: **no acoplar las apuestas al NIP principal**.

## 3. Colisiones de kinds — ⚠️ decisión pendiente

Verificado contra el README oficial, `nostr-protocol/registry-of-kinds`
(schema.yaml) y `nostrdata/kinds`:

| Kind nuestro | Veredicto | Detalle |
|---|---|---|
| **31337 (score)** | **COLISIÓN CONFIRMADA** | Es **"Audio Track"** de facto (Zapstr, Stemstr, Wavlake, desde ~2023), registrado en `registry-of-kinds` y documentado en el [PR #1043](https://github.com/nostr-protocol/nips/pull/1043). **Hay que renumerarlo antes del NIP.** |
| 31338 (atestación) | libre | Ausente de las tres fuentes. |
| 31340 (estado escrow) | libre | Ausente de las tres fuentes. |
| 1339 (contrato) | libre | Ojo con vecinos: 1337 = Code Snippet (NIP-C0), 1311 = Live Chat (NIP-53). |
| 1341 (resultado) | libre | Ausente de las tres fuentes. |
| 24940–24942 (NGE) | sin verificar en relays | No aparecen en los registros; falta chequear uso de facto con un `REQ` a relays grandes. |

**Decisión pendiente (renumerar 31337):** el rango 31339–31399 (salvo 31388)
aparece libre. Propuesta: migrar el score a **31339** (addressable), con
período de doble publicación/lectura en Luna, Tetris y el SDK. Es un cambio de
wire v2: deliberado, versionado y anunciado. Hasta decidirlo, el NIP draft
declara los números como provisionales.

**Advertencia que justifica apurarse:** el `kind:30` que usaba Jester (ajedrez)
fue **pisado** después por otro estándar (hoy es "internal reference",
NKBIP-03). Un kind sin registrar no es de nadie.

## 4. Plan de acción (en orden)

### Fase A — Asegurar el terreno (barato, ya)
1. **Decidir la renumeración del 31337** (ver §3) y ejecutar la migración
   (SDK + Luna + Tetris, doble lectura durante la transición).
2. **PR a [`registry-of-kinds`](https://github.com/nostr-protocol/registry-of-kinds)**
   registrando nuestros kinds (score renumerado, 31338, 31340, 1339, 1341 y
   los NGE 24940–24942). El registro acepta "any reasonable event definition"
   sin exigir implementaciones — es la reserva de bajo costo que nos protege
   del escenario Jester.
3. **`REQ` a relays grandes** (relay.damus.io, nos.lol, relay.nostr.band) por
   los kinds 31338/31340/1339/1341/24940–24942 para descartar uso de facto no
   registrado.

### Fase B — El NIP (dividido en capas separables)
4. **NIP principal: "Game Events"** — identidad del juego (coordenada NIP-23),
   score, atestación, presencia (convención sobre NIP-38), retos (convención
   sobre NIP-17). Draft en [games.md](games.md). Citar NIP-64 como precedente
   de juego nicho aceptado.
5. **Apuestas/escrow como documento aparte** (segundo NIP o NUD), para que la
   fricción histórica del escrow no hunda el PR principal. NGE va aparte
   también (análogo a cómo NWC/NIP-47 es su propio NIP).
6. La discusión ocurre **en el PR mismo**; fiatjaf y un grupo con commit
   access deciden. Prepararse para la objeción "esto es un NUD, no un NIP" con
   el argumento que funcionó en NIP-64: implementaciones reales + uso real.

### Fase C — La segunda implementación y los aliados
7. **Conseguir una implementación independiente** (el requisito duro). Candidatos
   detectados, en orden de afinidad:
   - **[Nostr Game Engine](https://ngengine.org/)** — motor de juegos sobre Nostr,
     **muy activo** (push el mismo día de la investigación). Ya hace auth Nostr,
     matchmaking, logros NIP-58. Es el aliado natural: proponerle adoptar
     score/atestación. (Identidad del mantenedor sin verificar; averiguar antes
     de contactar.)
   - **[Chain Duel](https://chainduel.net/)** — juego Lightning competitivo con
     login Nostr y leaderboard de zappers; publicar su leaderboard como eventos
     score sería adopción visible.
   - **[DEG Mods](https://degmods.com/)** — plataforma de mods sobre Nostr, activa;
     afinidad parcial (reseñas/zaps).
   - **THNDR Games** — pionero del "Gaming Graph" (badges NIP-58), pero pivoteó
     a B2B/casino en 2025; vigencia dudosa.
   - Los juegos del ecosistema propio (pacman-pwa, sammer, bitbybit-run) sirven
     como demos pero no como "implementación independiente" a ojos del repo.
8. **Difusión en Nostr mismo**: publicar la spec como long-form (30023) desde el
   npub del proyecto, con los ejemplos de eventos; pedir feedback citando a los
   proyectos de arriba.

### Fase D — Mantener la credibilidad
9. Mantener [docs/spec/](../spec/README.md) como fuente canónica con historial
   de cambios de wire; los test vectors como criterio de conformidad público.
10. Documentar cada implementación conocida en la tabla de la spec (quién habla
    qué nivel). Eso es lo que un tercero mira para decidir si sube.

## 5. Registro de contactos y estado

| Quién | Canal | Estado | Próximo paso |
|---|---|---|---|
| Nostr Game Engine | GitHub org / npub (por confirmar) | sin contactar | verificar mantenedor, abrir issue proponiendo score+atestación |
| Chain Duel | npub `primal.net/chainduel` | sin contactar | DM proponiendo publicar leaderboard como eventos |
| DEG Mods | npub conocido | sin contactar | opcional |
| registry-of-kinds | PR GitHub | pendiente | tras renumeración |
| nostr-protocol/nips | PR GitHub | pendiente | tras Fase A + segunda implementación encaminada |
