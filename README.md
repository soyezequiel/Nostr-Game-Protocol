# Nostr Game Protocol

**Marcadores, presencia, retos 1v1 y apuestas en sats para tu juego web — sin cuentas, sin base de datos de usuarios y sin atarte a ninguna plataforma.**

---

## El problema

Hiciste un juego. Ahora querés un ranking, que tus jugadores se reten entre sí, o apostar unos sats en una partida. El camino habitual es una lista larga: sistema de cuentas, base de datos, API propia, recuperación de contraseñas, y una integración a medida con alguna plataforma que —si un día cambia sus términos o cierra— se lleva tus rankings y tus usuarios con ella.

Hay otro camino: **tu jugador ya tiene una identidad** (su clave Nostr) y ya existe una red de relays donde publicar datos firmados que cualquiera puede leer y verificar. Un puntaje puede ser un evento firmado por el jugador. La presencia "jugando X", también. Un reto a un amigo, un mensaje cifrado entre ellos dos. Nada de eso necesita que vos operes un servidor de usuarios — y nada de eso deja de funcionar si una tienda, incluida la nuestra, desaparece mañana.

Este paquete es la implementación de ese camino: dos protocolos (**NGP** y **NGE**) que conectan juegos con [Luna Negra](https://github.com/soyezequiel/luna-negra), una tienda de juegos con identidad Nostr y pagos Lightning. Es el **mismo código exacto** que corre la tienda en producción: no hay una "versión para partners" — el formato de cada evento existe una sola vez, acá.

## Cómo se ve

Publicar el récord de un jugador, firmado por él:

```ts
import { buildScoreTemplate } from "nostr-game-protocol/ngp";

const template = buildScoreTemplate({
  gameCoord: "30023:<pubkey-del-dev>:mi-juego",  // la identidad Nostr de tu juego
  board: "clasico",
  score: 42_000,
});
const signed = await window.nostr.signEvent(template);  // NIP-07, NIP-46 o clave local
// publicás `signed` a tus relays con nostr-tools — listo, ranking sin backend
```

Apuestas con escrow entre dos o más jugadores, desde tu game server. Toda la configuración es **un string**:

```ts
// .env → NGE_CONNECTION="nostr+nge://<escrow>?relay=wss://…&secret=<nsec>"
import { NGE } from "nostr-game-protocol/nge";

const nge = NGE.fromEnv();
const bet = await nge.createBet({
  seats: [                         // 2 o más asientos: el pozo lo arma la mesa entera
    { seatId: "alice", pubkey: alicePk },
    { seatId: "bob" },
    { seatId: "carol" },
  ],
  stakeSats: 1000,                 // por asiento
  condition: "Último en pie gana",
  clientRef: "match-42",           // idempotencia: reintentar nunca duplica
});
for (const d of bet.deposits) showQr(d.seatId, d.bolt11);  // un invoice por asiento

await nge.reportResult(bet.betId, ["alice"]);  // tu juego es el oráculo
// (varios ganadores también vale: ["alice", "bob"] reparte el pozo entre ellos)
```

Sin API key, sin webhooks que configurar, sin SDK de pagos. El jugador paga un invoice Lightning; el ganador cobra solo. Si conocés [NWC](https://nwc.dev), esto es la misma idea aplicada a escrow.

## Qué trae exactamente el paquete

Dos cosas. Primero, **la definición exacta de cada mensaje** que se intercambian la tienda y el juego: qué tipo de evento Nostr es, qué campos lleva, cómo se arma y cómo se lee. Y segundo, **funciones de conveniencia** para usar esos mensajes sin reimplementar el formato a mano.

> Una aclaración de vocabulario: en este repo, **wire** es el *formato de los datos tal como viajan de un programa a otro* —el "cable" entre la tienda y el juego—. No es el relay ni la conexión de red: es el formato del mensaje en sí.

| Import | Qué trae | Quién lo usa |
| --- | --- | --- |
| `nostr-game-protocol/ngp` | Templates firmables (puntaje, presencia), reto 1v1 cifrado, interfaz `NgpSigner` | El juego |
| `nostr-game-protocol/nge` | Clase `NGE` (cliente del escrow), transporte inyectable, `auditSettlement` | El juego |
| `nostr-game-protocol/ngp-core` | Solo el wire NGP: kinds, templates sin firmar, parsers. **Cero dependencias.** | La tienda |
| `nostr-game-protocol/nge-core` | Solo el wire NGE: kinds efímeros, URI de conexión, cifrado NIP-44 | El escrow |
| `nostr-game-protocol/bal` | Auto login por Bunker URI: cliente, launcher, NIP-46 y `postMessage` seguro | Juego y launcher |
| `nostr-game-protocol/bal-core` | Wire, validadores, permisos, consentimiento y transportes abstractos | Cualquier runtime |

No es todo-o-nada: podés adoptar solo el marcador, o solo la presencia, o solo las apuestas. Cada bloque es independiente.

## Los dos protocolos

**NGP (Nostr Games Protocol)** es la capa pública: presencia NIP-38 ("Jugando X"), marcador `kind:31339`, retos 1v1 por NIP-17 (cifrados de punta a punta — ni la tienda puede leerlos), y la liquidación transparente de apuestas (contrato `1339`, resultado `1341`, estado del escrow `31340`). Todo son eventos Nostr estándar: cualquier cliente Nostr los lee, no solo Luna Negra.

**NGE (Nostr Game Escrow)** es la capa privada: el canal por donde tu juego coordina una apuesta con el escrow. Es un RPC cifrado (NIP-44) sobre eventos efímeros, calcado del diseño de NWC: request/response, el relay es un caño tonto, la fuente de verdad vive en el escrow. La coordinación es privada; la liquidación pública (NGP) es opcional por apuesta.

**BAL (Bunker Auto Login)** es una capa de transporte y autorización sobre NIP-46: un launcher entrega al juego una Bunker URI temporal después de validar ventana/origen e identidad y obtener consentimiento. La `nsec` nunca se entrega al juego.

Se complementan: NGE coordina en privado, NGP publica lo que la apuesta decida hacer público.

## Decisiones de diseño

Cuatro, y explican casi todo el código:

1. **El wire vive en un solo lugar, y está congelado.** El problema clásico de dos programas que se hablan es que cada uno reimplementa el formato "a su manera" y tarde o temprano divergen. Acá el formato de cada evento existe una sola vez, en las capas `-core`, y la tienda y el juego importan exactamente el mismo código. Cambiar un kind o un tag no es un refactor: es cambiar el protocolo, y los tests de conformidad contra vectores firmados están para recordártelo.

2. **Protocolo puro, sin contexto pegado.** Cero relays hardcodeados, cero variables de entorno, cero I/O. Todo lo contextual —qué relay, qué coordenada, con qué clave firmar— entra por parámetro. El núcleo NGP ni siquiera depende de `nostr-tools`. Por eso el mismo código corre en el navegador del jugador, en un worker serverless y en un test sin red.

3. **La ergonomía de cada lado vive en cada lado.** El wire es compartido; cómo lo usás, no. Las capas `-core` casi nunca cambian; la capa de cliente/firma evoluciona sin tocar el protocolo.

4. **Nostr-nativo de punta a punta.** La identidad del jugador es su clave (NIP-07/NIP-46); la identidad del juego es una coordenada NIP-23 descentralizada (`30023:<pubkey-del-dev>:<slug>`), no un ID interno de la tienda. Presencia y retos son NIPs estándar: interoperables por diseño, no por promesa.

## Lo que este paquete no resuelve

Conviene saberlo antes de empezar, no después:

- **El marcador `kind:31339` lo firma el cliente del jugador: es falsificable.** Sirve para rankings sociales; nunca lo uses para repartir dinero. Para eso está el escrow, donde el resultado lo reporta tu game server.
- **El escrow NGE es custodial — pero el custodio podés ser vos.** El escrow custodia el pozo mientras la apuesta corre. El diseño acota el daño (un `secret` filtrado puede elegir ganador entre los asientos declarados, no redirigir fondos; toda acción del escrow puede quedar anclada como evento firmado y verificable), pero custodial es custodial — el protocolo no lo esconde. Lo que **no** está atado es *quién* custodia: la URI solo nombra una `escrow-pubkey` + relays, así que el rol de escrow no es de Luna Negra por definición. Podés correr tu propio escrow, o que tu propio game server sea el custodio. Ojo con esto último: si el juego es su propio escrow, custodia los fondos **y** decide el ganador (es el oráculo) — la separación de terceros se colapsa, y eso es self-custody, no escrow de tercero. La contra: el SDK trae el **cliente** (`NGE`) llave-en-mano, pero no un servidor de escrow: para ser custodio implementás vos el lado servidor con las primitivas de `nge-core` (los templates de response/notification, el cifrado simétrico ya están; la referencia es `nge-service.ts` de Luna). Los [test vectors](#desarrollo) son tu criterio de conformidad.
- **Es un protocolo joven.** El wire está congelado y en producción, pero el ecosistema hoy es una tienda y los juegos que integra. Si eso te parece poco, es razonable; si te parece temprano-y-por-eso-interesante, también.

## Estado

En producción. Luna Negra (el escrow/tienda) y [Tetris](https://github.com/soyezequiel/tetris-para-luna-negra) (el primer juego integrado) corren este paquete tal cual está en `main` — apuestas reales con sats reales incluidas. Los kinds están congelados; los cambios de wire son eventos raros y deliberados.

## Instalación

```sh
npm i github:soyezequiel/Nostr-Game-Protocol
npm i nostr-tools   # peer dependency
```

No hay paso de build para vos: el paquete compila TypeScript a `dist/` en su `prepare`, así que la dependencia git funciona tal cual en Vercel, en un Docker o donde sea que corra `npm install`.

## Desarrollo

```sh
npm install          # instala y compila (prepare)
npm test             # vitest: conformidad NGE/NGP contra los vectores
npm run build        # emite dist/ (ESM + .d.ts)
npm run gen:vectors  # regenera vectors/nge-test-vectors.json
```

Los **test vectors** (`vectors/nge-test-vectors.json`) son eventos NGE firmados con claves y nonce fijos: `content` e `id` deterministas. Si estás implementando tu propio escrow o cliente, son tu criterio de conformidad — cualquier implementación correcta los reproduce exactamente.

## Specs

**La especificación canónica vive en este repo**, en [`docs/spec/`](docs/spec/):

- [`docs/spec/ngp.md`](docs/spec/ngp.md) — la capa pública: marcador, atestación, presencia, retos.
- [`docs/spec/ngp-bets.md`](docs/spec/ngp-bets.md) — el escrow transparente por eventos.
- [`docs/spec/nge.md`](docs/spec/nge.md) — el RPC cifrado de NGE.
- [`docs/spec/bal.md`](docs/spec/bal.md) — auto login modular sobre NIP-46.
- [`docs/nip/games.md`](docs/nip/games.md) — el draft de NIP (inglés) para proponer a `nostr-protocol/nips`.

Luna Negra y los juegos son **implementaciones** de esta spec; sus docs internos
(`docs/nostr-games-protocol*.md` en el repo de Luna) son notas de implementación,
no la fuente de verdad.

## Licencia

MIT.
