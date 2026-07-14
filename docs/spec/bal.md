# BAL v1 — Bunker Auto Login sobre NIP-46

BAL (`org.nostr.bunker-auto-login`) negocia una Bunker URI temporal entre un
launcher y un juego. No define un sistema de identidad ni una firma nueva: una
vez entregada la URI, todas las operaciones son NIP-46 `kind:24133`.

## Flujo

1. El juego crea una clave NIP-46 efímera y envía `BAL_READY` al origen exacto del launcher.
2. El launcher valida `event.origin`, `event.source`, juego, versión, `requestId`, `nonce`, permisos y `clientPubkey`.
3. El launcher elige su identidad activa; el juego no envía una pubkey de usuario.
4. Sin una autorización recordada que coincida exactamente, el launcher pide consentimiento.
5. El launcher crea un remote signer NIP-46 efímero y envía `BAL_SESSION`.
6. El juego canjea la URI una sola vez, ejecuta `get_public_key` y continúa su login Nostr normal.

`expiresAt` es Unix en milisegundos. `BAL_ERROR` termina el intento sin impedir
el login normal o invitado. `BAL_LOGOUT` puede viajar en ambas direcciones.

## Mensajes y permisos

Todos llevan `protocol`, `version: 1`, `type`, `requestId` y `nonce`.

- `BAL_READY`: `gameId`, `clientPubkey`, `requestedPermissions`.
- `BAL_SESSION`: `bunkerUri`, `expiresAt`.
- `BAL_ERROR`: `code`, `message`.
- `BAL_LOGOUT`: `reason` opcional.

Los permisos válidos son `get_public_key`, `sign_event`, `sign_event:<kind>`,
`nip04_encrypt`, `nip04_decrypt`, `nip44_encrypt` y `nip44_decrypt`.

El launcher declara el origen de su firmante como `email`, `nsec` o `nip07`.
Con `nip07`, cada operación sigue delegándose al complemento del navegador: BAL
no obtiene ni simula una clave privada local.

## Garantías de la implementación de referencia

- `WebPostMessageTransport` rechaza `targetOrigin="*"` y orígenes opacos.
- La Bunker URI y su secret sólo viven en memoria; ningún store BAL los acepta.
- La pubkey del `bunker://` pertenece al servicio efímero, no al usuario.
- El secret sólo permite el primer `connect`; luego queda consumido.
- El remote signer verifica firma, autor, destinatario, frescura, duplicados,
  expiración y permisos antes de delegar al signer del launcher.
- Una autorización recordada queda ligada a juego, origen, identidad, pubkey,
  tipo de firmante y conjunto exacto de permisos. Cualquier cambio exige
  consentimiento nuevo.
- El núcleo no importa DOM. `BalTransport` y los puertos reservados permiten
  agregar variables de entorno, IPC, eventos Nostr, deep links o consolas.

## Imports

```ts
import { BalGameClient, WebPostMessageTransport } from "nostr-game-protocol/bal";
import { BalLauncher } from "nostr-game-protocol/bal-launcher";
import { parseBalReady } from "nostr-game-protocol/bal-core";
```

El juego debe conservar la clave de cliente sólo durante esa apertura y no debe
persistir la Bunker URI. El launcher mantiene vivo `BalLauncher` mientras la
ventana registrada del juego siga abierta.
