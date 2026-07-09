// SDK NGE v2 (Nostr Game Escrow) — punto de entrada del lado JUEGO.
//
// Barrel del protocolo completo, partido en dos capas:
//   - `nge-core.ts`   → protocolo PURO (kinds, URI, cifrado NIP-44, templates).
//                       Compartido con el escrow (Luna Negra importa
//                       `nostr-game-protocol/nge-core`). El wire está congelado por la
//                       spec, así que casi nunca cambia.
//   - `nge-client.ts` → ergonomía del cliente (clase `NGE`, tipos de la API,
//                       transporte, `auditSettlement`).
//
// El juego importa de este barrel (`nostr-game-protocol/nge`) desde un puerto propio; el
// resto del juego habla con el puerto, nunca con el SDK.
// Peer dependency: nostr-tools.
export * from "./nge-core.js";
export * from "./nge-client.js";
