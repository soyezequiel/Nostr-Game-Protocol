# NGP — Nostr Games Protocol (capa pública)

> **Estado: estable.** Los kinds propios de este documento (31339, 31338) están
> congelados y en producción. Las palabras clave **DEBE / NO DEBE / PUEDE**
> siguen el sentido de RFC 2119.
>
> Implementación de referencia del wire: [`src/ngp-core.ts`](../../src/ngp-core.ts)
> (templates y parsers) y [`src/ngp.ts`](../../src/ngp.ts) (firma y reto NIP-17).

NGP define cómo un juego publica su capa social en Nostr — marcador, presencia,
retos, reseñas — usando **exclusivamente eventos Nostr**, sin API propietaria ni
servidor central. Lo que un juego publica con esta spec lo puede leer cualquier
cliente Nostr, y sigue funcionando aunque desaparezca la plataforma que lo
distribuye.

---

## 1. Identidad y anclas

### 1.1 Identidad del jugador

La pubkey Nostr del jugador (hex / `npub`), obtenida con **NIP-07** (extensión)
o **NIP-46** (firmador remoto). El juego NO DEBE crear cuentas propias: la
pubkey es el `playerId` estable.

### 1.2 Identidad del juego — la coordenada

Cada juego se identifica por una **coordenada NIP-23**:

```
30023:<pubkey-del-dev>:<slug>
```

Es el `a`-tag del artículo (`kind:30023`) que describe el juego. La coordenada
no depende de ninguna plataforma: existe mientras el artículo exista en algún
relay, y es el **ancla de todos los eventos** de esta spec. A lo largo del
documento, `GAME` = esa coordenada.

El artículo del juego PUEDE declarar además la **delegación de oráculo**
(ver §3.2):

```jsonc
{
  "kind": 30023,
  "pubkey": "<pubkey-del-dev>",
  "tags": [
    ["d", "mi-juego"],
    ["title", "Mi juego"],
    ["oracle", "<pubkey-del-oráculo>"]   // opcional: qué clave puede atestar/resolver
  ],
  "content": "…descripción en markdown…"
}
```

---

## 2. Marcador — `kind:31339`

> **Renumeración (2026-07).** El score usaba `kind:31337`, que colisiona con
> "Audio Track" de facto (Zapstr/Stemstr/Wavlake). Los escritores DEBEN emitir
> **solo 31339**; los lectores DEBERÍAN aceptar también 31337 durante la
> transición (`NGP_SCORE_READ_KINDS` en el core la implementa).

Un puntaje es un evento **addressable**, firmado **por el jugador**, anclado a
la coordenada del juego.

```jsonc
{
  "kind": 31339,
  "pubkey": "b2f7…d4a1",                                  // firma el JUGADOR
  "created_at": 1751760000,
  "tags": [
    ["a", "30023:79be…f817:tetra"],                       // GAME — ancla
    ["d", "30023:79be…f817:tetra:clasico"],               // <GAME>:<board>
    ["board", "clasico"],
    ["score", "128400"],                                  // entero ≥ 0, como string
    ["client", "tetra-web"]                               // opcional: quién originó
  ],
  "content": ""                                           // opcional: JSON libre de metadata
}
```

### Reglas normativas

- **`d` DEBE ser `<GAME>:<board>`** → un jugador tiene exactamente **un
  registro por tabla**; el relay reemplaza el anterior automáticamente.
- **`board`** DEBE matchear `^[a-z0-9][a-z0-9_-]{0,63}$`. Lo elige el juego
  (`clasico`, `semanal`, `speedrun`…) y permite varios rankings por juego.
- **`score`** DEBE ser un entero no negativo serializado como string. Tope de
  referencia: `1_000_000_000` (los verificadores PUEDEN clampear o descartar
  valores mayores).
- El tag opcional `unit` (`points`|`ms`|`goals`|…) aclara el sentido; el
  cliente que rankea decide el orden según `unit` (`ms` = menor es mejor).
- Si además se quiere histórico de intentos, se PUEDE publicar un evento
  **regular** (no addressable, sin `d`) con los mismos tags. Es opcional.

### Leer el ranking (cualquier cliente)

```jsonc
{ "kinds": [31339], "#a": ["30023:79be…f817:tetra"], "#board": ["clasico"] }
```

El cliente agrupa por `pubkey`, ordena por `score` y resuelve nombre/avatar con
el `kind:0` de cada jugador. No hace falta ninguna plataforma.

### ⚠️ Anti-trampa — la regla más importante de esta spec

El score lo firma el **cliente del jugador**: es **falsificable**. Sirve para
rankings sociales. Un verificador **NO DEBE** usar un `kind:31339` para
disparar pagos ni repartir premios. Para eso existen la atestación (§3) y el
escrow ([ngp-bets](ngp-bets.md)).

---

## 3. Atestación de oráculo — `kind:31338`

Segundo nivel del marcador: un **oráculo** (server-side — p. ej. el room-server
del juego) certifica un resultado que **presenció**. Convive con el tier
abierto: un ranking "verificado" solo cuenta atestaciones del oráculo
autorizado del juego.

```jsonc
{
  "kind": 31338,
  "pubkey": "e1a9…77c3",                                  // firma el ORÁCULO
  "created_at": 1751760300,
  "tags": [
    ["a", "30023:79be…f817:tetra"],                       // GAME
    ["d", "30023:79be…f817:tetra:room-8f21"],             // <GAME>:<ref> — permanente
    ["ref", "room-8f21"],                                 // id único de lo atestado (sala/partida)
    ["p", "b2f7…d4a1"],                                   // jugador certificado (ganador)
    ["e", "<id del 31339 atestado>"],                     // opcional: qué score atestigua
    ["score", "128400"],                                  // opcional: puntaje certificado
    ["status", "verified"]                                 // verified | rejected
  ],
  "content": ""
}
```

### Reglas normativas

- **`d` DEBE ser `<GAME>:<ref>`** con `ref` único por partida → el registro es
  **permanente** (nada lo reemplaza); re-firmar el mismo `ref` lo corrige.
- `status`: `verified` certifica; `rejected` anula una atestación previa
  (el `p` del jugador PUEDE omitirse en un `rejected`).
- El oráculo DEBE certificar solo lo que su servidor realmente vio (resultados
  arbitrados server-side), nunca un score reportado por un cliente.

### 3.2 Delegación: quién es el oráculo autorizado

Como el oráculo casi nunca es la identidad raíz del dev, el artículo del juego
(`kind:30023`) **declara** qué pubkey puede atestar en su nombre, con un tag
`["oracle", "<pubkey>"]` o un `p`-tag con token `oracle`. Un verificador DEBE
confiar en una atestación **solo si** su firmante coincide con esa pubkey
declarada (y su firma criptográfica verifica). Sin declaración de oráculo, el
juego no tiene tier verificado.

---

## 4. Presencia "jugando X" — NIP-38 (`kind:30315`)

El firmador del jugador publica su estado; no requiere servidor.

```jsonc
{
  "kind": 30315,
  "pubkey": "b2f7…d4a1",                                  // firma el JUGADOR
  "created_at": 1751760000,
  "tags": [
    ["d", "general"],                                     // NIP-38: estado de actividad
    ["a", "30023:79be…f817:tetra"],                       // a qué juego refiere
    ["expiration", "1751760060"]                          // NIP-40, TTL ~30–60 s
  ],
  "content": "Jugando TETRA 🎮"
}
```

- El `content` es la copy visible; la decide el juego, no el protocolo.
- **Limpiar la presencia** al salir: mismo evento con `content` vacío y
  `expiration` inmediata (`created_at + 1`).
- Un lector DEBE considerar activa una presencia solo si tiene contenido y su
  `expiration` no pasó.

---

## 5. Reto 1v1 — NIP-17 (gift-wrap)

Un reto es un **DM cifrado de punta a punta** (NIP-17/NIP-59): ni el relay ni
ninguna plataforma pueden leerlo. El contenido en claro es un **rumor
`kind:14`** (sin firmar, por NIP-59):

```jsonc
{
  "kind": 14,
  "pubkey": "<pubkey del retador>",
  "created_at": 1751760000,
  "tags": [
    ["p", "<pubkey del retado>"],
    ["game", "30023:79be…f817:tetra"],                    // coordenada del juego
    ["room", "sala-8f21"],                                // sala online donde se juega
    ["url", "https://mi-juego.example/?join=sala-8f21"],  // link de entrada (?join, estándar único)
    ["expiration", "1751763600"]                          // vencimiento del reto (default 1 h)
  ],
  "content": "¡Te reto a una partida!"
}
```

El rumor se **sella** (`kind:13`, cifrado NIP-44 hacia el destinatario, firmado
por el remitente) y se **envuelve** (`kind:1059`, cifrado con clave efímera).
Ambos sobres llevan `created_at` aleatorizado hasta 2 días hacia atrás (NIP-59).

### Reglas normativas

- El receptor DEBE verificar que `rumor.pubkey == seal.pubkey` (anti-suplantación
  NIP-59) antes de confiar en el remitente.
- El receptor DEBE descartar retos vencidos (`expiration` pasada) y retos cuyo
  `game` no coincida con su propia coordenada.
- El receptor DEBERÍA validar que el `url` sea de su propio origin antes de
  navegar (no seguir links a orígenes ajenos).
- El `url` usa el **formato estándar de entrada a sala**: `<gameUrl>/?join=<roomId>`
  (helpers `buildRoomLink` / `parseRoomLink` en `ngp-core`). Es el MISMO link que arma
  el "Invitar a jugar" (Room Link) de la tienda — un solo camino de entrada. El juego
  crea la sala *lazy* (unir-o-crear con ese id) al abrir el link.
- Los retos se publican en los **relays de DM del destinatario** (`kind:10050`,
  NIP-17); si no publicó lista, en los relays acordados por la aplicación.
- El emisor PUEDE mandarse una auto-copia (mismo rumor, sellado hacia sí mismo)
  para su historial; es opcional y best-effort.

---

## 6. Actividad, reseñas y zaps — NIPs estándar

Nada propio que definir; NGP fija solo **el ancla**:

- **Reseñas / comentarios / logros**: `kind:1` con tag `a` = `GAME`.
- **Propinas y premios**: zaps NIP-57 al dev o al ganador; el recibo
  (`kind:9735`) es verificable y permite "top de zappers" por juego.

---

## 7. Qué NO cubre NGP puro

Honestidad de diseño: **Nostr es mensajería firmada, no liquidación de dinero.**

| Caso | Por qué | Dónde vive |
|---|---|---|
| Custodia de apuestas | retener un stake y pagar exige custodio | [ngp-bets](ngp-bets.md) (escrow transparente) + [nge](nge.md) (coordinación) |
| Compra de juego de pago | alguien debe validar el pago Lightning | fuera de esta spec (API de la plataforma) |
| Multijugador en tiempo real | posible con efímeros (20000–29999) pero el esquema es de cada juego | extensión no estándar |
