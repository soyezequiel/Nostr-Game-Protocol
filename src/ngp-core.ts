// NGP — NÚCLEO DE PROTOCOLO (puro, compartido tienda ⇄ juegos).
//
// Esta capa es SOLO la gramática de los eventos públicos del Nostr Games
// Protocol: kinds congelados, templates SIN firmar y parsers estructurales.
// No firma, no verifica firmas, no toca relays ni DB — ambas puntas la importan
// y no pueden desincronizarse porque el formato del wire vive acá, en un solo
// lugar. La ergonomía de cada punta vive aparte: en el juego, `ngp.ts`
// (firma con NgpSigner, reto NIP-17 juego↔juego); en la tienda, los servicios
// (score-sync, live-presence, ngp-bet-*), que agregan firma de la tienda,
// política del escrow y proyección a la DB.
//
// Este repo (nostr-game-protocol) es la fuente de verdad del wire; la tienda y los juegos
// lo consumen como paquete (`nostr-game-protocol/ngp-core`). Sin dependencias:
// ni siquiera nostr-tools — la verificación de firmas es del caller.
//
// El formato de estos eventos está CONGELADO: cambiarlo acá es cambiar el
// protocolo, no un detalle de implementación.
// Spec: docs/nostr-games-protocol.md y docs/nostr-games-protocol-apuestas.md.

/** Template SIN firmar de un evento NGP (subset de EventTemplate de nostr-tools;
 *  `created_at` opcional: si falta, lo pone quien firma/publica). */
export type NgpEventTemplate = {
  kind: number;
  created_at?: number;
  tags: string[][];
  content: string;
};

/** Template con `created_at` ya fijado (asignable a EventTemplate de nostr-tools). */
export type NgpTimestampedTemplate = NgpEventTemplate & { created_at: number };

/** Subconjunto estructural de un evento Nostr firmado, para los parsers. Es
 *  compatible con `Event` de nostr-tools sin importarlo. ⚠️ Los parsers NO
 *  verifican la firma: eso es del caller (`verifyEvent`). */
export type NgpEventLike = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
};

/** Kinds NGP/NIPs que habla el protocolo. */
export const NGP_KIND = {
  rumor: 14, // NIP-17: el reto en claro (sin firmar, por NIP-59)
  seal: 13, // NIP-59: rumor cifrado, firmado por el remitente
  giftWrap: 1059, // NIP-59: seal cifrado con clave efímera
  dmInboxRelays: 10050, // NIP-17: lista de relays de DM del destinatario
  presence: 30315, // NIP-38: user status ("Jugando X")
  score: 31339, // NGP: puntaje addressable firmado por el jugador (renumerado 2026-07; antes 31337)
  scoreLegacy: 31337, // kind VIEJO del puntaje — SOLO lectura durante la transición.
  // Se renumeró porque 31337 es "Audio Track" de facto (Zapstr/Stemstr/Wavlake,
  // registry-of-kinds). Los builders ya no lo emiten; los parsers lo siguen
  // aceptando hasta que termine la doble lectura (ver docs/nip/roadmap.md).
  scoreAttestation: 31338, // NGP: atestación del oráculo (spec §3.4). Certifica un
  // resultado que el oráculo presenció (p. ej. el ganador de un versus).
  betContract: 1339, // NGP apuestas: contrato (regular, firma el retador)
  betResult: 1341, // NGP apuestas: resultado (regular, firma el oráculo)
  betState: 31340, // NGP apuestas: estado del escrow / terms (addressable, firma el escrow)
} as const;

// Alias congelados de la capa de apuestas (los nombres con los que la tienda
// los importó siempre; mismos valores que NGP_KIND.bet*).
export const NGP_BET_CONTRACT_KIND = NGP_KIND.betContract;
export const NGP_BET_RESULT_KIND = NGP_KIND.betResult;
export const NGP_BET_STATE_KIND = NGP_KIND.betState;

// Tag `t` de descubrimiento de TODOS los eventos NGP de apuestas.
export const NGP_BET_TAG = "ngp-bet";

const now = () => Math.floor(Date.now() / 1000);

/** Primer valor del tag `name`, o null. */
function tagValue(ev: { tags: string[][] }, name: string): string | null {
  const v = ev.tags.find((t) => t[0] === name)?.[1];
  return typeof v === "string" ? v : null;
}

// ── Marcador (kind:31339) ────────────────────────────────────────────────────

/** Kinds a pedir en los FILTROS de lectura del marcador mientras dure la
 *  transición 31337 → 31339: el nuevo primero, el legacy después. Cuando se
 *  cierre la doble lectura, este array queda en [NGP_KIND.score]. */
export const NGP_SCORE_READ_KINDS: number[] = [NGP_KIND.score, NGP_KIND.scoreLegacy];

/** Tope que acepta la tienda para el puntaje (entero 0…1e9). */
export const NGP_MAX_SCORE = 1_000_000_000;

/** Nombre de tabla válido según la spec: ^[a-z0-9][a-z0-9_-]{0,63}$ (no empieza
 *  con `_`/`-`). Se valida al construir para no publicar un `d`-tag que la
 *  tienda descarte. */
export const NGP_BOARD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * Template del evento de puntaje (kind:31339). `a`=gameCoord ancla al juego;
 * `d`=`<coord>:<board>` hace que sea el único récord del jugador en esa tabla
 * (se auto-reemplaza al mejorar). ⚠️ Lo firma el CLIENTE del jugador: es
 * falsificable — sirve para rankings sociales, nunca para repartir dinero.
 * Lanza si el board o el puntaje son inválidos; clampa el puntaje al tope.
 */
export function buildScoreTemplate(p: {
  gameCoord: string;
  board: string;
  score: number;
  client?: string;
  createdAt?: number;
}): NgpTimestampedTemplate {
  if (!NGP_BOARD_RE.test(p.board)) {
    throw new Error(`Nombre de tabla inválido: ${p.board}`);
  }
  const value = Math.floor(p.score);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Puntaje inválido: ${p.score}`);
  }
  const clamped = Math.min(value, NGP_MAX_SCORE);
  return {
    kind: NGP_KIND.score,
    created_at: p.createdAt ?? now(),
    tags: [
      ["a", p.gameCoord], // ancla al juego (30023:<pubkey-del-dev>:<slug>)
      ["d", `${p.gameCoord}:${p.board}`], // 1 récord por jugador y tabla
      ["board", p.board],
      ["score", String(clamped)],
      ...(p.client ? [["client", p.client]] : []),
    ],
    content: "",
  };
}

export type NgpParsedScore = {
  /** Coordenada del juego (tag `a`). Siempre presente: sin ella el evento no es de nadie. */
  gameCoord: string;
  /** Nombre de tabla (tag `board`), o null si el cliente no lo mandó (la tienda
   *  aplica su default). NO se valida contra NGP_BOARD_RE acá: el rango/gramática
   *  final los decide quien proyecta (p. ej. `submitScore`). */
  board: string | null;
  /** Puntaje ya convertido a número finito. */
  score: number;
};

/**
 * Desarma un evento de puntaje kind:31339 (acepta también el legacy 31337
 * mientras dure la doble lectura). Devuelve null si el kind no es el de
 * puntaje, falta la coordenada (`a`) o el `score` no es un número finito.
 * ⚠️ No verifica la firma: hacé `verifyEvent(ev)` antes de confiar en él.
 */
export function parseScoreEvent(ev: NgpEventLike): NgpParsedScore | null {
  if (ev.kind !== NGP_KIND.score && ev.kind !== NGP_KIND.scoreLegacy) return null;
  const gameCoord = tagValue(ev, "a");
  if (!gameCoord) return null;
  const score = Number(tagValue(ev, "score"));
  if (!Number.isFinite(score)) return null;
  return { gameCoord, board: tagValue(ev, "board"), score };
}

// ── Presencia NIP-38 (kind:30315) ────────────────────────────────────────────

/** `d`="general" es el estado de actividad (el otro valor reservado por la NIP
 *  es "music", que no usamos). */
export const NGP_PRESENCE_D_TAG = "general";

/**
 * Template de presencia NIP-38 (kind:30315) anclada al juego con `a`=gameCoord
 * (la tienda filtra por ESE coord exacto para derivar "Jugando X"). `message`
 * es la copy visible ("Jugando TETRA") — la decide el juego, no el protocolo.
 */
export function buildPresenceTemplate(p: {
  gameCoord: string;
  message: string;
  ttlSec: number;
  createdAt?: number;
}): NgpTimestampedTemplate {
  const createdAt = p.createdAt ?? now();
  return {
    kind: NGP_KIND.presence,
    created_at: createdAt,
    tags: [
      ["d", NGP_PRESENCE_D_TAG],
      ["a", p.gameCoord],
      ["expiration", String(createdAt + p.ttlSec)],
    ],
    content: p.message,
  };
}

/**
 * Cuánto vive el CLEAR en los relays (NIP-40). ⚠️ No puede ser "inmediato"
 * (`createdAt + 1`): un evento que nace ya vencido es RECHAZADO por algunos
 * relays ("event is expired") o purgado antes de propagarse — y en esos relays
 * la presencia ACTIVA queda como último evento del slot, así que el jugador
 * "resucita" como jugando cuando un cliente los consulta (p. ej. al refrescar
 * la tienda), hasta que la presencia vieja vence por su propio TTL. Lo que hace
 * al evento un CLEAR es el `content` vacío, no la expiración: los lectores lo
 * tratan como "dejó de jugar" apenas lo ven. La expiración holgada solo lo
 * mantiene vivo lo suficiente para pisar de forma fiable en TODOS los relays.
 */
export const NGP_PRESENCE_CLEAR_TTL_SEC = 120;

/**
 * Template que LIMPIA la presencia (NIP-38: content vacío), para que
 * "Jugando X" desaparezca ya al cerrar el juego.
 *
 * Pasá `gameCoord` (la coordenada del juego que se está limpiando) siempre que
 * la tengas: sin el tag `a`, un observador que filtre presencia por `#a` (el
 * patrón natural de una tienda) NUNCA ve el clear — y como 30315 es
 * reemplazable, el clear PISA a la presencia activa en el relay, así que ese
 * observador solo "deja de ver" al jugador y lo retiene hasta que vence el
 * NIP-40 (minutos de "jugando ahora" fantasma). Es opcional solo por
 * compatibilidad con firmantes que no conocen la coord al momento del clear.
 */
export function buildPresenceClearTemplate(
  p: { createdAt?: number; gameCoord?: string; expiration?: number } = {},
): NgpTimestampedTemplate {
  const createdAt = p.createdAt ?? now();
  const tags = [["d", NGP_PRESENCE_D_TAG]];
  if (p.gameCoord) tags.push(["a", p.gameCoord]);
  // `expiration` (epoch absoluto) permite que un clear PRE-FIRMADO cubra toda la
  // vida de la presencia que apaga: si el despacho se demora (heartbeat colgado,
  // pestaña cerrada tarde), un clear que expiró antes que la presencia es
  // descartado por NIP-40 y el jugador queda "jugando" hasta su TTL. El
  // `Math.max` conserva el piso histórico: el clear NUNCA nace vencido (ver ⚠️
  // arriba en NGP_PRESENCE_CLEAR_TTL_SEC).
  const expiration = Math.max(p.expiration ?? 0, createdAt + NGP_PRESENCE_CLEAR_TTL_SEC);
  tags.push(["expiration", String(expiration)]);
  return {
    kind: NGP_KIND.presence,
    created_at: createdAt,
    tags,
    content: "",
  };
}

export type NgpParsedPresence = {
  /** Coordenada del juego (tag `a`), o null si el estado no ancla a un juego. */
  gameCoord: string | null;
  /** true si el estado sigue vigente: tiene contenido y no venció (NIP-40). */
  active: boolean;
  /** Expiración declarada (tag `expiration`), o null si no trae una válida. */
  expiresAt: number | null;
};

/**
 * Desarma un estado NIP-38. Devuelve null si el kind no es el de presencia.
 * `active` replica la regla de la tienda: contenido vacío = presencia limpiada,
 * `expiration` en el pasado = vencida. ⚠️ No verifica la firma.
 */
export function parsePresenceEvent(
  ev: NgpEventLike,
  nowSec: number = now(),
): NgpParsedPresence | null {
  if (ev.kind !== NGP_KIND.presence) return null;
  const expRaw = tagValue(ev, "expiration");
  const exp = expRaw !== null ? Number(expRaw) : NaN;
  // Vencida solo si trae una expiración numérica ya pasada (NaN nunca vence).
  const expired = exp < nowSec;
  return {
    gameCoord: tagValue(ev, "a"),
    active: ev.content.length > 0 && !expired,
    expiresAt: Number.isFinite(exp) ? exp : null,
  };
}

// ── Apuestas: estado del escrow (kind:31340) ─────────────────────────────────

export type NgpDepositEntry = { p: string; receipt?: string };
export type NgpPayoutEntry = {
  p: string;
  sats: number;
  status: string;
  kind?: string;
  zapRequest?: string;
  receipt?: string;
};

/**
 * Template del estado del escrow (kind:31340, addressable, `d` = id del ancla).
 * Es el registro máquina COMPLETO de la apuesta: asientos declarados, depósitos
 * con recibos, payouts, referencias al resultado y a la nota de liquidación.
 * Lo firma el ESCROW (la tienda).
 */
export function buildNgpBetStateTemplate(p: {
  anchorEventId: string;
  gameCoord?: string | null;
  status: string;
  reason?: string | null;
  betId: string;
  stakeSats: number;
  /** Pubkeys de los asientos declarados, en orden (el ancla kind:1 no lleva
   *  p-tags de jugadores: el registro vive acá). */
  participants: string[];
  feePct: number;
  devFeePct: number;
  depositDeadline?: number | null;
  resolveDeadline?: number | null;
  deposits: NgpDepositEntry[];
  payouts?: NgpPayoutEntry[];
  resultEventId?: string | null;
  settleNoteId?: string | null;
  createdAt?: number;
}): NgpEventTemplate {
  const content = JSON.stringify({
    betId: p.betId,
    status: p.status,
    ...(p.reason ? { reason: p.reason } : {}),
    stakeSats: p.stakeSats,
    seats: p.participants.length,
    participants: p.participants,
    feePct: p.feePct,
    devFeePct: p.devFeePct,
    ...(p.depositDeadline ? { depositDeadline: p.depositDeadline } : {}),
    ...(p.resolveDeadline ? { resolveDeadline: p.resolveDeadline } : {}),
    deposits: p.deposits,
    ...(p.payouts && p.payouts.length ? { payouts: p.payouts } : {}),
    ...(p.resultEventId ? { resultEvent: p.resultEventId } : {}),
    ...(p.settleNoteId ? { settleNote: p.settleNoteId } : {}),
  });
  return {
    kind: NGP_BET_STATE_KIND,
    ...(p.createdAt ? { created_at: p.createdAt } : {}),
    tags: [
      ["d", p.anchorEventId],
      ["e", p.anchorEventId],
      ...(p.gameCoord ? [["a", p.gameCoord]] : []),
      ["status", p.status],
      ["bet", p.betId],
      ["t", NGP_BET_TAG],
    ],
    content,
  };
}

/**
 * Template de las condiciones del escrow (kind:31340, `d`="terms"): comisiones
 * por defecto, límites de stake y ventanas. Lo que un juego lee ANTES de crear
 * un contrato (spec §2.1).
 */
export function buildNgpTermsTemplate(p: {
  minStakeSats: number;
  maxStakeSats: number;
  feePct: number;
  devFeeMaxPct: number;
  feeMinSats: number;
  maxSeats: number;
  depositWindowSec: number;
  resolveWindowSec: number;
  withdrawWindowSec: number;
}): NgpEventTemplate {
  return {
    kind: NGP_BET_STATE_KIND,
    tags: [
      ["d", "terms"],
      ["t", NGP_BET_TAG],
    ],
    content: JSON.stringify(p),
  };
}

// ── Apuestas: resultado (kind:1341) ──────────────────────────────────────────

/**
 * Template del resultado de una apuesta (kind:1341, regular, inmutable — spec
 * §5). Lo firma el ORÁCULO (gestionado o BYO): el escrow lo valida contra la
 * pubkey de oráculo declarada en el contrato.
 *
 * Tags: `e` = ancla del contrato (navegable), `a` = coordenada del juego,
 * `p` = pubkey de cada ganador, `status` = win|draw, `bet` = id interno
 * (correlación), `t` = ngp-bet (descubrimiento). `winnerPubkeys` vacío =
 * empate/anulación → `status=draw`, sin `p`.
 */
export function buildBetResultTemplate(p: {
  betId: string;
  winnerPubkeys: string[];
  anchorEventId?: string | null;
  gameCoord?: string | null;
  createdAt?: number;
}): NgpTimestampedTemplate {
  return {
    kind: NGP_BET_RESULT_KIND,
    created_at: p.createdAt ?? now(),
    tags: [
      ...(p.anchorEventId ? [["e", p.anchorEventId]] : []),
      ...(p.gameCoord ? [["a", p.gameCoord]] : []),
      ...p.winnerPubkeys.map((pk) => ["p", pk]),
      ["status", p.winnerPubkeys.length > 0 ? "win" : "draw"],
      ["bet", p.betId],
      ["t", NGP_BET_TAG],
    ],
    content: "",
  };
}

// ── Apuestas: contrato (kind:1339) ───────────────────────────────────────────

/** Un `p` tag es de ROL si trae "escrow"/"oracle" como token después de la
 *  pubkey (índice 2 = relay hint opcional, 3 = marker NIP-10; aceptamos
 *  cualquiera de los dos para no atarnos a que venga el relay). El resto son
 *  participantes. */
function roleOf(tag: string[]): "escrow" | "oracle" | null {
  for (const token of tag.slice(2)) {
    if (token === "escrow" || token === "oracle") return token;
  }
  return null;
}

export type NgpParsedBetContract = {
  /** Id del evento 1339. */
  contractId: string;
  /** Firmante del contrato (el retador): autoriza p. ej. el void pre-fondeo. */
  challengerPubkey: string;
  /** ¿Trae el tag de descubrimiento ["t","ngp-bet"]? */
  taggedNgpBet: boolean;
  /** Escrow declarado (`p` con rol "escrow"), o null. */
  escrowPubkey: string | null;
  /** Oráculo declarado (`p` con rol "oracle"), o null. */
  oraclePubkey: string | null;
  /** Participantes: los `p` sin rol, en el orden del evento. */
  participants: string[];
  /** Coordenada del juego (tag `a`), o null. */
  gameCoord: string | null;
  /** Stake declarado (tag `stake`), entero, o null si falta o no es entero. */
  stakeSats: number | null;
  /** Deadline de depósito declarado (tag `deadline`, epoch segundos > 0), o null. */
  deadlineSec: number | null;
  /** Sala donde se juega (tag `room`), o null. */
  roomId: string | null;
  /** Condición de victoria (el content del contrato, sin recortar). */
  victoryCondition: string;
  /** El post humano raíz del que cuelga el contrato (`e` con marker "root", o el
   *  primer `e`), o null si es P2P puro (el ancla es el propio 1339). */
  rootEventId: string | null;
};

/**
 * Desarma un contrato de apuesta kind:1339. Devuelve null solo si el kind no es
 * el de contrato; el resto de los campos vuelven crudos (null cuando faltan)
 * para que la POLÍTICA del escrow (rangos de stake, ventanas, cantidad de
 * asientos) decida con sus propios códigos de error. ⚠️ No verifica la firma.
 */
export function parseBetContractEvent(ev: NgpEventLike): NgpParsedBetContract | null {
  if (ev.kind !== NGP_BET_CONTRACT_KIND) return null;

  const pTags = ev.tags.filter((t) => t[0] === "p" && typeof t[1] === "string");
  const stakeNum = Number(tagValue(ev, "stake"));
  const deadlineNum = Number(tagValue(ev, "deadline"));

  return {
    contractId: ev.id,
    challengerPubkey: ev.pubkey,
    taggedNgpBet: ev.tags.some((t) => t[0] === "t" && t[1] === NGP_BET_TAG),
    escrowPubkey: pTags.find((t) => roleOf(t) === "escrow")?.[1] ?? null,
    oraclePubkey: pTags.find((t) => roleOf(t) === "oracle")?.[1] ?? null,
    participants: pTags.filter((t) => roleOf(t) === null).map((t) => t[1]),
    gameCoord: tagValue(ev, "a"),
    stakeSats: Number.isInteger(stakeNum) ? stakeNum : null,
    deadlineSec: Number.isFinite(deadlineNum) && deadlineNum > 0 ? deadlineNum : null,
    roomId: tagValue(ev, "room"),
    victoryCondition: ev.content ?? "",
    rootEventId:
      ev.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1] ??
      ev.tags.find((t) => t[0] === "e")?.[1] ??
      null,
  };
}

// ── Marcador verificado: atestación del oráculo (kind:31338) ─────────────────
//
// Segundo nivel del marcador (spec §3.4). El marcador kind:31339 lo firma el
// JUGADOR → es falsificable. La atestación kind:31338 la firma un ORÁCULO
// (server-side) que PRESENCIÓ el resultado — p. ej. el room-server del juego
// certificando "en la sala X ganó el jugador Y". Convive con el tier abierto: un
// ranking "verificado" solo cuenta atestaciones firmadas por el oráculo
// autorizado del juego.
//
// ⚠️ Vale lo que valga el oráculo: certificá solo lo que tu servidor realmente
// vio (resultados de versus arbitrados server-side), nunca un score de cliente.
//
// DELEGACIÓN: como el oráculo casi nunca es la identidad raíz del dev del coord,
// el listado del juego (kind:30023) DECLARA qué pubkey es el oráculo autorizado
// (`oraclePubkeyFromListing`). El verificador confía en la atestación solo si su
// firmante == esa pubkey declarada (`isAuthorizedAttestation`).

export type NgpAttestationStatus = "verified" | "rejected";

/**
 * Template SIN firmar de una atestación (kind:31338, addressable). La firma el
 * ORÁCULO. `d`=`<gameCoord>:<ref>` la hace un registro PERMANENTE por partida
 * (`ref` único → nada la reemplaza; re-firmar el mismo `ref` la corrige).
 * `status` por defecto "verified". `playerPubkey` es el jugador atestado (el
 * ganador del versus); omitirlo/"" para una anulación ("rejected").
 */
export function buildAttestationTemplate(p: {
  gameCoord: string;
  /** Id único de lo atestado (sala/partida). Ancla el registro permanente. */
  ref: string;
  /** Jugador certificado (ganador). Opcional para status "rejected". */
  playerPubkey?: string;
  status?: NgpAttestationStatus;
  /** Id del evento de score kind:31339 que se atestigua, si aplica. */
  scoreEventId?: string;
  /** Puntaje certificado (entero), opcional. */
  score?: number;
  createdAt?: number;
}): NgpTimestampedTemplate {
  if (!p.ref) throw new Error("La atestación necesita un `ref` (id de la partida).");
  const status = p.status ?? "verified";
  return {
    kind: NGP_KIND.scoreAttestation,
    created_at: p.createdAt ?? now(),
    tags: [
      ["a", p.gameCoord],
      ["d", `${p.gameCoord}:${p.ref}`], // 1 registro permanente por partida
      ["ref", p.ref],
      ...(p.playerPubkey ? [["p", p.playerPubkey]] : []),
      ...(p.scoreEventId ? [["e", p.scoreEventId]] : []),
      ...(p.score !== undefined ? [["score", String(Math.floor(p.score))]] : []),
      ["status", status],
    ],
    content: "",
  };
}

export type NgpParsedAttestation = {
  /** Quién FIRMÓ (pubkey del evento). El caller DEBE cruzarla con el oráculo
   *  autorizado del juego (`isAuthorizedAttestation`) antes de confiar. */
  oraclePubkey: string;
  /** Coordenada del juego (tag `a`), o null. */
  gameCoord: string | null;
  /** Id de lo atestado (tag `ref`), o null. */
  ref: string | null;
  /** Jugador certificado (primer tag `p`), o null. */
  playerPubkey: string | null;
  /** "verified" | "rejected" (u otro string que ponga el oráculo). */
  status: string;
  /** Id del evento de score referido (tag `e`), o null. */
  scoreEventId: string | null;
  /** Puntaje certificado (tag `score`), o null si falta o no es finito. */
  score: number | null;
};

/**
 * Desarma una atestación kind:31338. Devuelve null solo si el kind no es el de
 * atestación; el resto vuelve crudo. ⚠️ No verifica la firma (`verifyEvent`) ni
 * la autorización del oráculo (`isAuthorizedAttestation`): eso es del caller.
 */
export function parseAttestationEvent(ev: NgpEventLike): NgpParsedAttestation | null {
  if (ev.kind !== NGP_KIND.scoreAttestation) return null;
  const scoreRaw = tagValue(ev, "score");
  const scoreNum = Number(scoreRaw);
  return {
    oraclePubkey: ev.pubkey,
    gameCoord: tagValue(ev, "a"),
    ref: tagValue(ev, "ref"),
    playerPubkey: ev.tags.find((t) => t[0] === "p" && typeof t[1] === "string")?.[1] ?? null,
    status: tagValue(ev, "status") ?? "verified",
    scoreEventId: ev.tags.find((t) => t[0] === "e" && typeof t[1] === "string")?.[1] ?? null,
    score: scoreRaw !== null && Number.isFinite(scoreNum) ? scoreNum : null,
  };
}

/**
 * Extrae la pubkey del oráculo AUTORIZADO declarada en el listado del juego
 * (kind:30023) — la DELEGACIÓN. El dev que publica el listado declara qué clave
 * puede atestar en su nombre. Acepta `["oracle", <pk>]` o un `p` con token
 * "oracle" (mismo patrón que los roles del contrato de apuesta). Devuelve null si
 * el listado no declara oráculo (→ el juego no tiene tier verificado).
 */
export function oraclePubkeyFromListing(
  listing: { tags: string[][] } | null | undefined,
): string | null {
  if (!listing || !Array.isArray(listing.tags)) return null;
  const direct = listing.tags.find((t) => t[0] === "oracle" && typeof t[1] === "string")?.[1];
  if (direct) return direct;
  const pOracle = listing.tags.find(
    (t) => t[0] === "p" && typeof t[1] === "string" && t.slice(2).includes("oracle"),
  )?.[1];
  return pOracle ?? null;
}

/**
 * ¿La atestación la firmó el oráculo autorizado del juego? Cierra la delegación:
 * `declaredOraclePubkey` sale de `oraclePubkeyFromListing(listado del juego)`.
 * ⚠️ Verificá la firma criptográfica aparte (`verifyEvent(ev)`): esto solo compara
 * identidades, el core no depende de nostr-tools.
 */
export function isAuthorizedAttestation(
  att: NgpParsedAttestation,
  declaredOraclePubkey: string | null,
): boolean {
  return declaredOraclePubkey !== null && att.oraclePubkey === declaredOraclePubkey;
}

// ─── Link de entrada a sala (`?join`) ──────────────────────────────────────
//
// Convención ÚNICA y estándar para invitar a jugar en una sala hosteada por el
// juego: `<gameUrl>/?join=<roomId>`. La usan por igual el reto NIP-17 (el `url`
// del rumor, ver ngp.ts) y el "Invitar a jugar" de la tienda (Room Link). Antes
// la tienda usaba un parámetro propio (`?lnRoom`); se unificó a `?join` para que
// el juego tenga UN solo camino de entrada. El juego crea la sala lazy al abrir el
// link (unir-o-crear con ese id externo); es público (cualquiera con el link entra)
// y sin token de identidad — la identidad la resuelve el juego por Nostr.

/** Formato válido del id de sala en el link de entrada. */
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Arma el link canónico de entrada a una sala del juego: `<gameUrl>/?join=<roomId>`.
 *  Lanza si el `roomId` no cumple {@link ROOM_ID_RE}. */
export function buildRoomLink(gameUrl: string, roomId: string): string {
  if (!ROOM_ID_RE.test(roomId))
    throw new Error(`roomId inválido (esperado ${ROOM_ID_RE.source}): ${roomId}`);
  return `${gameUrl.replace(/\/+$/, "")}/?join=${encodeURIComponent(roomId)}`;
}

/** Extrae y valida el `roomId` de un link `?join=<id>` (URL completa o query string
 *  suelto, p. ej. `location.search`). Devuelve null si no hay un `join` válido. */
export function parseRoomLink(input: string): string | null {
  if (!input) return null;
  let search: URLSearchParams;
  try {
    search = new URL(input).searchParams;
  } catch {
    const q = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
    search = new URLSearchParams(q);
  }
  const id = search.get("join");
  return id && ROOM_ID_RE.test(id) ? id : null;
}
