/**
 * Generador de test vectors para NGE v2 (Nostr Game Escrow) — RPC estilo NWC.
 *
 * El protocolo es request/response cifrado (NIP-44) sobre eventos EFÍMEROS:
 *   - request  kind:24940, lo firma el cliente `C`, cifrado hacia el escrow `S`
 *   - response kind:24941, lo firma `S`, cifrado hacia `C`, tag e=<id request>
 *
 * Claves y NONCE NIP-44 FIJOS → el `content` cifrado y el `id` del evento son
 * deterministas y reproducibles. Las firmas schnorr llevan aux aleatorio: se
 * VERIFICAN, no se comparan. La clave de conversación es simétrica (C↔S), así que
 * un mismo ciphertext lo cifra `C` y lo descifra `S` (y viceversa).
 *
 * Correr:  node scripts/gen-vectors.cjs   (regenera vectors/nge-test-vectors.json)
 */
const { finalizeEvent, getPublicKey, verifyEvent } = require("nostr-tools/pure");
const { nip19, nip44 } = require("nostr-tools");
const fs = require("fs");
const path = require("path");

function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}
const bytesToHex = (b) => Buffer.from(b).toString("hex");

// ── Actores (claves de prueba, NO usar en producción) ───────────────────────
const SK = {
  escrow: "11".repeat(32), // Luna Negra (custodio) = `S`, host de la URI
  client: "22".repeat(32), // clave del juego = `C`, el `secret` de la URI
  attacker: "66".repeat(32), // clave hostil sin credencial (adversarial)
};
const PK = Object.fromEntries(
  Object.entries(SK).map(([k, v]) => [k, getPublicKey(hexToBytes(v))]),
);

const T0 = 1751760000; // created_at base (fijo)
const RELAY = "wss://relay.luna.fit";
// Nonce NIP-44 fijo SOLO para reproducibilidad de los vectores. En producción
// nip44.encrypt genera un nonce aleatorio por mensaje.
const NONCE = hexToBytes("ab".repeat(32));

const KIND = { request: 24940, response: 24941, notification: 24942 };

// Clave de conversación NIP-44 entre C y S (simétrica).
const CK = nip44.getConversationKey(hexToBytes(SK.client), PK.escrow);
const enc = (payload) => nip44.encrypt(JSON.stringify(payload), CK, NONCE);
const dec = (content) => JSON.parse(nip44.decrypt(content, CK));

// ── La URI de conexión NGE v2 — MÍNIMA: 3 campos ─────────────────────────────
// host = pubkey estable del escrow; relay = transporte; secret = clave de `C`.
// TODO lo demás (límites, fees, métodos) se pide por RPC (`get_info`): sin bind.
function buildUri() {
  const q = new URLSearchParams();
  q.set("relay", RELAY);
  q.set("secret", nip19.nsecEncode(hexToBytes(SK.client)));
  return `nostr+nge://${PK.escrow}?${q.toString()}`;
}
const uri = buildUri();
const parsed = (() => {
  const u = new URL(uri);
  const p = u.searchParams;
  const d = nip19.decode(p.get("secret"));
  return {
    escrowPubkey: u.host,
    relays: p.getAll("relay"),
    clientPubkey: getPublicKey(d.data),
  };
})();

// ── Helpers de firma ─────────────────────────────────────────────────────────
function signRequest(payload, createdAt = T0, extraTags = []) {
  const tmpl = {
    kind: KIND.request,
    created_at: createdAt,
    tags: [["p", PK.escrow], ...extraTags],
    content: enc(payload),
  };
  return finalizeEvent(tmpl, hexToBytes(SK.client));
}
function signResponse(payload, requestId, createdAt = T0 + 1) {
  const tmpl = {
    kind: KIND.response,
    created_at: createdAt,
    tags: [["p", PK.client], ["e", requestId]],
    content: enc(payload),
  };
  return finalizeEvent(tmpl, hexToBytes(SK.escrow));
}

// Un par request/response canónico (camino feliz) para un método.
function rpcPair({ method, params, resultType, result }) {
  const requestPayload = { method, params };
  const request = signRequest(requestPayload);
  const responsePayload = { result_type: resultType ?? method, result };
  const response = signResponse(responsePayload, request.id);
  return { method, requestPayload, request, responsePayload, response };
}

// ── Datos del flujo canónico (una apuesta 1v1) ───────────────────────────────
const BET_ID = "clbet0000000000000000000n"; // cuid de ejemplo (estable)
const STAKE = 1000;
const DEADLINE = T0 + 3600;
const SEATS = [
  { seatId: "alice", pubkey: getPublicKey(hexToBytes("33".repeat(32))), payoutAddress: "alice@getalby.com" },
  { seatId: "bob" }, // sin pubkey ni lud16 → cobra por QR de retiro
];

const canonical = [
  rpcPair({
    method: "get_info",
    params: {},
    result: {
      methods: ["get_info", "create_bet", "get_bet", "report_result", "cancel_bet"],
      version: "1.1",
      currency: "sat",
      minStakeSats: 100,
      maxStakeSats: 500000,
      feePct: 2,
      devFeePct: 1,
      // v1.1: piso de comisión (para que auditSettlement no adivine).
      feeMinSats: 10,
      // Capacidad del ESCROW (no del canal): liquida en público con eventos NGP.
      // `visibilityOptions` = modos que acepta `create_bet.visibility`.
      transparency: "public",
      visibilityOptions: ["public", "unlisted"],
      // v1.1: tipos de notification 24942 que emite (§9). Ausente = solo polling.
      notifications: ["bet_updated"],
      // v1.1: límites por credencial; excederlos → error RATE_LIMITED (§7).
      limits: { createBetPerMin: 30, maxPendingBets: 50 },
      // v1.1: ventana de disputa (§7.1). 0 = liquidación inmediata.
      settleDelaySec: 0,
      settleDelayMinPotSats: 0,
    },
  }),
  rpcPair({
    method: "create_bet",
    params: { seats: SEATS, stakeSats: STAKE, condition: "Mejor de 3 en Pac-Toshi", clientRef: "match-42", roomId: "SALA-P7Q2" },
    // v1.1: la response ES el detalle completo (mismo shape que get_bet) MÁS los
    // handles de depósito — la creación queda en un solo RPC. Recién creada, el
    // detalle es trivial: nadie depositó y no hay resultado.
    result: {
      betId: BET_ID,
      status: "pending_deposits",
      stakeSats: STAKE,
      potSats: 0,
      deadlineSec: DEADLINE,
      seats: [
        { seatId: "alice", deposited: false, bolt11: "lnbc10u1p...alice", payout: null },
        { seatId: "bob", deposited: false, bolt11: "lnbc10u1p...bob", payout: null },
      ],
      result: null,
      deposits: [
        { seatId: "alice", bolt11: "lnbc10u1p...alice", amountSats: STAKE, expiresAt: DEADLINE },
        { seatId: "bob", bolt11: "lnbc10u1p...bob", amountSats: STAKE, expiresAt: DEADLINE },
      ],
    },
  }),
  rpcPair({
    method: "get_bet",
    params: { betId: BET_ID },
    result: {
      betId: BET_ID,
      status: "funded",
      stakeSats: STAKE,
      potSats: STAKE * 2,
      deadlineSec: DEADLINE,
      seats: [
        { seatId: "alice", deposited: true, payout: null },
        { seatId: "bob", deposited: true, payout: null },
      ],
      result: null,
    },
  }),
  rpcPair({
    method: "report_result",
    params: { betId: BET_ID, winners: ["alice"] },
    result: { ok: true, status: "settled" },
  }),
];

// ── Notification 24942 `bet_updated` (push, §9, v1.1) ────────────────────────
// La firma `S`, cifrada hacia `C`, tag p=<C> y SIN tag `e` (no responde a ningún
// request). NO autoritativa: despierta al cliente, que confirma con get_bet.
function signNotification(payload, createdAt = T0 + 2) {
  const tmpl = {
    kind: KIND.notification,
    created_at: createdAt,
    tags: [["p", PK.client]],
    content: enc(payload),
  };
  return finalizeEvent(tmpl, hexToBytes(SK.escrow));
}

const notificationPayload = {
  notification_type: "bet_updated",
  notification: { betId: BET_ID, status: "funded", deposited: ["alice", "bob"] },
};
const notifications = [
  {
    name: "bet_updated (segundo depósito acreditado → funded)",
    payload: notificationPayload,
    event: signNotification(notificationPayload),
  },
];

// ── Casos adversariales — qué debe DECIDIR el escrow ─────────────────────────
// No son "eventos válidos"; documentan la respuesta correcta ante entradas
// hostiles o mal formadas. El escrow (src/lib/nge-service.ts) debe cumplirlos.
const attackerCK = nip44.getConversationKey(hexToBytes(SK.attacker), PK.escrow);
const attackerRequest = finalizeEvent(
  {
    kind: KIND.request,
    created_at: T0,
    tags: [["p", PK.escrow]],
    content: nip44.encrypt(JSON.stringify({ method: "get_info", params: {} }), attackerCK, NONCE),
  },
  hexToBytes(SK.attacker),
);
const staleRequest = signRequest({ method: "get_info", params: {} }, T0 - 4000);

const adversarial = [
  {
    name: "cliente sin credencial",
    request: attackerRequest,
    expect: { error: { code: "UNAUTHORIZED" } },
    why: "El request está bien firmado y descifra, pero la pubkey no tiene credencial emitida (§6). El escrow no atiende clientes desconocidos.",
  },
  {
    name: "request fuera de la ventana de frescura",
    request: staleRequest,
    expect: { error: { code: "EXPIRED_REQUEST" } },
    why: "created_at está a >5 min del ahora del escrow (§6). Anti-replay: se rechaza aunque venga de una `C` válida.",
  },
  {
    name: "stake fuera de rango",
    method: "create_bet",
    params: { seats: SEATS, stakeSats: 5 },
    expect: { error: { code: "STAKE_OUT_OF_RANGE" } },
    why: "stakeSats por debajo de minStakeSats de get_info. El escrow valida contra sus propios límites, no confía en el cliente.",
  },
  {
    name: "ganador no fondeado",
    method: "report_result",
    params: { betId: BET_ID, winners: ["carol"] },
    expect: { error: { code: "BAD_WINNER" } },
    why: "El seatId ganador no existe / no está fondeado (§7). winners debe ser subconjunto de asientos pagados.",
  },
  {
    name: "reporte sobre apuesta no fondeada",
    method: "report_result",
    params: { betId: BET_ID, winners: ["alice"] },
    expect: { error: { code: "NOT_FUNDED" } },
    why: "report_result solo vale con status=funded (§7). En pending_deposits se rechaza.",
  },
  {
    name: "resultado ya liquidado con otro ganador",
    method: "report_result",
    params: { betId: BET_ID, winners: ["bob"] },
    expect: { error: { code: "ALREADY_SETTLED" } },
    why: "Finalidad (§7): una vez settled, el resultado no se reescribe. Un reintento IDÉNTICO devolvería ok; uno distinto es error.",
  },
  {
    name: "cancelar apuesta ya fondeada",
    method: "cancel_bet",
    params: { betId: BET_ID },
    expect: { error: { code: "NOT_CANCELLABLE" } },
    why: "cancel_bet solo pre-fondeo total (§8). Fondeada, la única salida es report_result (winners vacío = anular).",
  },
  {
    name: "credencial que excede el límite de creación",
    method: "create_bet",
    params: { seats: SEATS, stakeSats: STAKE },
    expect: { error: { code: "RATE_LIMITED" } },
    why: "v1.1 (§7): el escrow limita create_bet por credencial (get_info.limits: createBetPerMin, maxPendingBets). Excederlo devuelve RATE_LIMITED; el cliente reintenta con backoff. Los reintentos del MISMO evento no cuentan (dedup por id).",
  },
];

// ── Sanity: todo evento canónico/adversarial debe VERIFICAR firma y round-trip ──
const allEvents = [
  ...canonical.flatMap((c) => [c.request, c.response]),
  ...notifications.map((n) => n.event),
  attackerRequest,
  staleRequest,
];
for (const ev of allEvents) {
  if (!verifyEvent(ev)) throw new Error(`evento no verifica: kind ${ev.kind} id ${ev.id}`);
}
for (const c of canonical) {
  const back = dec(c.request.content);
  if (JSON.stringify(back) !== JSON.stringify(c.requestPayload)) {
    throw new Error(`round-trip roto en request de ${c.method}`);
  }
  const backR = dec(c.response.content);
  if (JSON.stringify(backR) !== JSON.stringify(c.responsePayload)) {
    throw new Error(`round-trip roto en response de ${c.method}`);
  }
}
for (const n of notifications) {
  if (JSON.stringify(dec(n.event.content)) !== JSON.stringify(n.payload)) {
    throw new Error(`round-trip roto en notification "${n.name}"`);
  }
  if (n.event.tags.some((t) => t[0] === "e")) {
    throw new Error(`la notification "${n.name}" no debe llevar tag e (§9)`);
  }
}

// ── Serialización ────────────────────────────────────────────────────────────
const vectors = {
  version: "1.1",
  note:
    "NGE v2 (RPC cifrado estilo NWC), spec v1.1: create_bet devuelve el detalle " +
    "completo, push 24942 bet_updated, RATE_LIMITED + limits, ventana de disputa. " +
    "Claves y nonce NIP-44 fijos → content e id deterministas; las firmas se " +
    "verifican, no se comparan. Regenera con `node docs/nge/gen-vectors.js`.",
  kinds: KIND,
  keys: {
    escrow: { sk: SK.escrow, pubkey: PK.escrow, npub: nip19.npubEncode(PK.escrow) },
    client: { sk: SK.client, pubkey: PK.client, nsec: nip19.nsecEncode(hexToBytes(SK.client)) },
    attacker: { sk: SK.attacker, pubkey: PK.attacker },
  },
  uri,
  parsed,
  crypto: { conversationKey: bytesToHex(CK), nonce: bytesToHex(NONCE) },
  canonical,
  notifications,
  adversarial,
};

const outPath = path.join(__dirname, "..", "vectors", "nge-test-vectors.json");
fs.writeFileSync(outPath, JSON.stringify(vectors, null, 2) + "\n");
console.log(`✓ ${canonical.length} pares canónicos + ${adversarial.length} adversariales → ${path.relative(process.cwd(), outPath)}`);
