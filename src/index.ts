// Punto de entrada namespaceado: NGE (escrow) y NGP (eventos públicos) exportan
// nombres que pueden pisarse entre sí, así que el barrel raíz los separa.
// Para imports directos usá los subpaths del paquete:
//   nostr-game-protocol/nge       → core + cliente NGE (lado juego)
//   nostr-game-protocol/nge-core  → solo el wire NGE (lado escrow)
//   nostr-game-protocol/ngp       → core + firma/reto NGP (lado juego)
//   nostr-game-protocol/ngp-core  → solo el wire NGP (lado tienda)
export * as nge from "./nge.js";
export * as ngp from "./ngp.js";
export * as bal from "./bal.js";
