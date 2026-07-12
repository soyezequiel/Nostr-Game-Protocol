import { describe, it, expect } from "vitest";
import {
  NGP_KIND,
  NGP_BET_CONTRACT_KIND,
  NGP_BET_RESULT_KIND,
  NGP_BET_STATE_KIND,
  NGP_BET_TAG,
  NGP_MAX_SCORE,
  buildScoreTemplate,
  parseScoreEvent,
  buildPresenceTemplate,
  buildPresenceClearTemplate,
  parsePresenceEvent,
  buildNgpBetStateTemplate,
  buildNgpTermsTemplate,
  buildBetResultTemplate,
  parseBetContractEvent,
  buildAttestationTemplate,
  parseAttestationEvent,
  oraclePubkeyFromListing,
  isAuthorizedAttestation,
  type NgpEventLike,
} from "../src/ngp-core.js";

// Conformance del NÚCLEO de protocolo NGP (src/ngp-core.ts): el formato de estos
// eventos está CONGELADO y tienda + juegos lo consumen desde este paquete.
// Si un cambio rompe estos tests, está cambiando el protocolo — no un detalle
// de implementación.

const COORD = "30023:" + "a".repeat(64) + ":tetra";

/** Evento firmado de mentira: los parsers no verifican firma (eso es del caller). */
function asEvent(t: { kind: number; created_at?: number; tags: string[][]; content: string }): NgpEventLike {
  return {
    id: "e".repeat(64),
    pubkey: "f".repeat(64),
    created_at: t.created_at ?? 1_700_000_000,
    kind: t.kind,
    tags: t.tags,
    content: t.content,
  };
}

describe("marcador (kind:31339)", () => {
  it("renumeración: se escribe 31339, el legacy 31337 queda solo-lectura", () => {
    // 31337 colisiona con "Audio Track" de facto (registry-of-kinds); el wire
    // migró a 31339 con doble lectura. Ver docs/nip/roadmap.md.
    expect(NGP_KIND.score).toBe(31339);
    expect(NGP_KIND.scoreLegacy).toBe(31337);
  });

  it("template: ancla, d-tag por tabla, score clampeado", () => {
    const t = buildScoreTemplate({ gameCoord: COORD, board: "clasico", score: 1234.9, client: "tetra" });
    expect(t.kind).toBe(NGP_KIND.score);
    expect(t.tags).toContainEqual(["a", COORD]);
    expect(t.tags).toContainEqual(["d", `${COORD}:clasico`]);
    expect(t.tags).toContainEqual(["board", "clasico"]);
    expect(t.tags).toContainEqual(["score", "1234"]);
    expect(t.tags).toContainEqual(["client", "tetra"]);
  });

  it("template: clampea al tope y rechaza board/score inválidos", () => {
    const t = buildScoreTemplate({ gameCoord: COORD, board: "x", score: NGP_MAX_SCORE + 5 });
    expect(t.tags).toContainEqual(["score", String(NGP_MAX_SCORE)]);
    expect(() => buildScoreTemplate({ gameCoord: COORD, board: "_mal", score: 1 })).toThrow();
    expect(() => buildScoreTemplate({ gameCoord: COORD, board: "ok", score: -1 })).toThrow();
  });

  it("parse: ida y vuelta con el template", () => {
    const ev = asEvent(buildScoreTemplate({ gameCoord: COORD, board: "sprint", score: 42 }));
    expect(parseScoreEvent(ev)).toEqual({ gameCoord: COORD, board: "sprint", score: 42 });
  });

  it("parse: doble lectura — acepta también el kind legacy 31337", () => {
    const ev = asEvent(buildScoreTemplate({ gameCoord: COORD, board: "sprint", score: 42 }));
    expect(parseScoreEvent({ ...ev, kind: NGP_KIND.scoreLegacy })).toEqual({
      gameCoord: COORD,
      board: "sprint",
      score: 42,
    });
  });

  it("parse: null si el kind, la coordenada o el score no cierran", () => {
    const ok = asEvent(buildScoreTemplate({ gameCoord: COORD, board: "b1", score: 7 }));
    expect(parseScoreEvent({ ...ok, kind: 1 })).toBeNull();
    expect(parseScoreEvent(asEvent({ kind: NGP_KIND.score, tags: [["score", "7"]], content: "" }))).toBeNull();
    expect(
      parseScoreEvent(asEvent({ kind: NGP_KIND.score, tags: [["a", COORD], ["score", "nope"]], content: "" })),
    ).toBeNull();
  });

  it("parse: board ausente vuelve null (el default lo pone la tienda)", () => {
    const ev = asEvent({ kind: NGP_KIND.score, tags: [["a", COORD], ["score", "9"]], content: "" });
    expect(parseScoreEvent(ev)).toEqual({ gameCoord: COORD, board: null, score: 9 });
  });
});

describe("presencia NIP-38 (kind:30315)", () => {
  it("template: d=general, ancla y expiración = created_at + ttl", () => {
    const t = buildPresenceTemplate({ gameCoord: COORD, message: "Jugando TETRA", ttlSec: 60, createdAt: 1000 });
    expect(t.kind).toBe(NGP_KIND.presence);
    expect(t.tags).toContainEqual(["d", "general"]);
    expect(t.tags).toContainEqual(["a", COORD]);
    expect(t.tags).toContainEqual(["expiration", "1060"]);
    expect(t.content).toBe("Jugando TETRA");
  });

  it("clear: contenido vacío + expiración HOLGADA (no nace vencido)", () => {
    const t = buildPresenceClearTemplate({ createdAt: 1000 });
    expect(t.content).toBe("");
    // ⚠️ NO createdAt+1: un evento que nace ya vencido es rechazado/purgado por
    // algunos relays (NIP-40) y la presencia activa "resucita" en ellos. El clear
    // lo define el content vacío; la expiración solo lo mantiene vivo para pisar.
    expect(t.tags).toContainEqual(["expiration", "1120"]);
    // Aun "vigente" por NIP-40, un lector lo trata como clear (content vacío).
    expect(parsePresenceEvent(asEvent(t), 1005)?.active).toBe(false);
  });

  it("clear con `expiration` override: la respeta si supera el piso, nunca por debajo", () => {
    // Override por encima del piso (clear pre-firmado que cubre la vida de la
    // presencia que apaga): se respeta tal cual.
    const long = buildPresenceClearTemplate({ createdAt: 1000, expiration: 1300 });
    expect(long.tags).toContainEqual(["expiration", "1300"]);
    // Override por DEBAJO del piso: gana el piso — el clear nunca nace vencido.
    const short = buildPresenceClearTemplate({ createdAt: 1000, expiration: 1001 });
    expect(short.tags).toContainEqual(["expiration", "1120"]);
  });

  it("clear con gameCoord: ancla `a` al juego que limpia (visible vía #a) y sigue inactiva", () => {
    const t = buildPresenceClearTemplate({ createdAt: 1000, gameCoord: COORD });
    expect(t.tags).toContainEqual(["a", COORD]);
    const parsed = parsePresenceEvent(asEvent(t), 1000);
    expect(parsed?.gameCoord).toBe(COORD);
    expect(parsed?.active).toBe(false);
    // Sin coord no agrega el tag (compat con firmantes que no la conocen).
    expect(buildPresenceClearTemplate({ createdAt: 1000 }).tags.some((x) => x[0] === "a")).toBe(false);
  });

  it("parse: activa mientras no venza, inactiva vencida o limpiada", () => {
    const fresh = asEvent(buildPresenceTemplate({ gameCoord: COORD, message: "Jugando", ttlSec: 60, createdAt: 1000 }));
    expect(parsePresenceEvent(fresh, 1030)).toEqual({ gameCoord: COORD, active: true, expiresAt: 1060 });
    expect(parsePresenceEvent(fresh, 2000)?.active).toBe(false);
    const cleared = asEvent(buildPresenceClearTemplate({ createdAt: 1000 }));
    expect(parsePresenceEvent(cleared, 1000)?.active).toBe(false);
    expect(parsePresenceEvent({ ...fresh, kind: 1 }, 1030)).toBeNull();
  });

  it("parse: sin expiración numérica no vence (expiresAt null)", () => {
    const ev = asEvent({ kind: NGP_KIND.presence, tags: [["d", "general"], ["a", COORD]], content: "Jugando" });
    expect(parsePresenceEvent(ev, 999_999_999)).toEqual({ gameCoord: COORD, active: true, expiresAt: null });
  });
});

describe("apuestas: estado del escrow (kind:31340)", () => {
  it("estado: tags d/e/a/status/bet/t y registro completo en el content", () => {
    const t = buildNgpBetStateTemplate({
      anchorEventId: "anchor1",
      gameCoord: COORD,
      status: "accepted",
      betId: "bet1",
      stakeSats: 100,
      participants: ["p1", "p2"],
      feePct: 5,
      devFeePct: 1,
      deposits: [{ p: "p1", receipt: "r1" }],
    });
    expect(t.kind).toBe(NGP_BET_STATE_KIND);
    expect(t.tags).toContainEqual(["d", "anchor1"]);
    expect(t.tags).toContainEqual(["e", "anchor1"]);
    expect(t.tags).toContainEqual(["a", COORD]);
    expect(t.tags).toContainEqual(["status", "accepted"]);
    expect(t.tags).toContainEqual(["bet", "bet1"]);
    expect(t.tags).toContainEqual(["t", NGP_BET_TAG]);
    const body = JSON.parse(t.content);
    expect(body).toMatchObject({
      betId: "bet1",
      status: "accepted",
      stakeSats: 100,
      seats: 2,
      participants: ["p1", "p2"],
      deposits: [{ p: "p1", receipt: "r1" }],
    });
    expect(body.payouts).toBeUndefined();
  });

  it("terms: d=terms con las condiciones publicadas", () => {
    const t = buildNgpTermsTemplate({
      minStakeSats: 10,
      maxStakeSats: 1000,
      feePct: 5,
      devFeeMaxPct: 2,
      feeMinSats: 1,
      maxSeats: 8,
      depositWindowSec: 600,
      resolveWindowSec: 3600,
      withdrawWindowSec: 3600,
    });
    expect(t.kind).toBe(NGP_BET_STATE_KIND);
    expect(t.tags).toContainEqual(["d", "terms"]);
    expect(JSON.parse(t.content).maxSeats).toBe(8);
  });
});

describe("apuestas: resultado (kind:1341)", () => {
  it("win: e/a/p por ganador, status=win, bet y t", () => {
    const t = buildBetResultTemplate({
      betId: "bet1",
      winnerPubkeys: ["1".repeat(64)],
      anchorEventId: "anchor1",
      gameCoord: COORD,
    });
    expect(t.kind).toBe(NGP_BET_RESULT_KIND);
    expect(t.tags).toContainEqual(["e", "anchor1"]);
    expect(t.tags).toContainEqual(["a", COORD]);
    expect(t.tags).toContainEqual(["p", "1".repeat(64)]);
    expect(t.tags).toContainEqual(["status", "win"]);
    expect(t.tags).toContainEqual(["bet", "bet1"]);
    expect(t.tags).toContainEqual(["t", NGP_BET_TAG]);
  });

  it("draw: sin ganadores no hay p y status=draw; sin ancla no hay e", () => {
    const t = buildBetResultTemplate({ betId: "bet1", winnerPubkeys: [] });
    expect(t.tags.filter((x) => x[0] === "p")).toHaveLength(0);
    expect(t.tags.filter((x) => x[0] === "e")).toHaveLength(0);
    expect(t.tags).toContainEqual(["status", "draw"]);
  });
});

describe("apuestas: contrato (kind:1339)", () => {
  const escrow = "a".repeat(64);
  const oracle = "b".repeat(64);
  const p1 = "1".repeat(64);
  const p2 = "2".repeat(64);

  function contractEvent(overrides: Partial<NgpEventLike> = {}): NgpEventLike {
    return {
      id: "c".repeat(64),
      pubkey: p1,
      created_at: 1_700_000_000,
      kind: NGP_BET_CONTRACT_KIND,
      tags: [
        ["t", NGP_BET_TAG],
        ["p", escrow, "wss://relay", "escrow"],
        ["p", oracle, "oracle"],
        ["p", p1],
        ["p", p2],
        ["a", COORD],
        ["stake", "100"],
        ["deadline", "1700000600"],
        ["room", "sala-9"],
        ["e", "root1", "", "root"],
      ],
      content: "Gana el primero en llegar a 40 líneas",
      ...overrides,
    };
  }

  it("desarma roles, participantes, stake, deadline y ancla raíz", () => {
    const c = parseBetContractEvent(contractEvent());
    expect(c).toMatchObject({
      contractId: "c".repeat(64),
      challengerPubkey: p1,
      taggedNgpBet: true,
      escrowPubkey: escrow,
      oraclePubkey: oracle,
      participants: [p1, p2],
      gameCoord: COORD,
      stakeSats: 100,
      deadlineSec: 1_700_000_600,
      roomId: "sala-9",
      rootEventId: "root1",
    });
    expect(c?.victoryCondition).toMatch(/40 líneas/);
  });

  it("acepta el rol en índice 2 (sin relay hint) y en índice 3 (con hint)", () => {
    const c = parseBetContractEvent(contractEvent());
    // escrow venía con hint (índice 3), oracle sin hint (índice 2): ambos cuentan.
    expect(c?.escrowPubkey).toBe(escrow);
    expect(c?.oraclePubkey).toBe(oracle);
  });

  it("campos crudos: faltantes → null (la política del escrow decide el error)", () => {
    const c = parseBetContractEvent(
      contractEvent({ tags: [["p", p1], ["p", p2], ["stake", "no-entero"]] }),
    );
    expect(c).toMatchObject({
      taggedNgpBet: false,
      escrowPubkey: null,
      oraclePubkey: null,
      gameCoord: null,
      stakeSats: null,
      deadlineSec: null,
      roomId: null,
      rootEventId: null,
    });
  });

  it("sin marker root usa el primer e; otro kind → null", () => {
    const c = parseBetContractEvent(contractEvent({ tags: [["e", "solo-e"]] }));
    expect(c?.rootEventId).toBe("solo-e");
    expect(parseBetContractEvent(contractEvent({ kind: 1 }))).toBeNull();
  });
});

describe("marcador verificado: atestación del oráculo (kind:31338)", () => {
  const oracle = "d".repeat(64); // firmante (clave dedicada del oráculo)
  const winner = "1".repeat(64);

  it("template: ancla, d permanente por partida, p del ganador, status verified", () => {
    const t = buildAttestationTemplate({ gameCoord: COORD, ref: "sala-9", playerPubkey: winner });
    expect(t.kind).toBe(NGP_KIND.scoreAttestation);
    expect(t.tags).toContainEqual(["a", COORD]);
    expect(t.tags).toContainEqual(["d", `${COORD}:sala-9`]); // único → registro permanente
    expect(t.tags).toContainEqual(["ref", "sala-9"]);
    expect(t.tags).toContainEqual(["p", winner]);
    expect(t.tags).toContainEqual(["status", "verified"]);
  });

  it("template: score/scoreEventId opcionales; rejected sin ganador; ref vacío lanza", () => {
    const t = buildAttestationTemplate({
      gameCoord: COORD,
      ref: "m1",
      playerPubkey: winner,
      score: 128400.9,
      scoreEventId: "score1",
    });
    expect(t.tags).toContainEqual(["score", "128400"]);
    expect(t.tags).toContainEqual(["e", "score1"]);

    const rej = buildAttestationTemplate({ gameCoord: COORD, ref: "m2", status: "rejected" });
    expect(rej.tags.filter((x) => x[0] === "p")).toHaveLength(0);
    expect(rej.tags).toContainEqual(["status", "rejected"]);

    expect(() => buildAttestationTemplate({ gameCoord: COORD, ref: "" })).toThrow();
  });

  it("parse: ida y vuelta; oraclePubkey = firmante; otro kind → null", () => {
    const ev: NgpEventLike = {
      ...asEvent(buildAttestationTemplate({ gameCoord: COORD, ref: "sala-9", playerPubkey: winner, score: 40 })),
      pubkey: oracle,
    };
    expect(parseAttestationEvent(ev)).toEqual({
      oraclePubkey: oracle,
      gameCoord: COORD,
      ref: "sala-9",
      playerPubkey: winner,
      status: "verified",
      scoreEventId: null,
      score: 40,
    });
    expect(parseAttestationEvent({ ...ev, kind: 1 })).toBeNull();
  });

  it("delegación: lee el oráculo del listado 30023 (tag oracle o p con rol)", () => {
    expect(oraclePubkeyFromListing({ tags: [["oracle", oracle]] })).toBe(oracle);
    expect(oraclePubkeyFromListing({ tags: [["p", oracle, "wss://r", "oracle"]] })).toBe(oracle);
    expect(oraclePubkeyFromListing({ tags: [["p", oracle]] })).toBeNull(); // p sin rol no cuenta
    expect(oraclePubkeyFromListing({ tags: [["d", "tetris-beta"]] })).toBeNull();
    expect(oraclePubkeyFromListing(null)).toBeNull();
  });

  it("autorización: true solo si el firmante == oráculo declarado", () => {
    const att = parseAttestationEvent({
      ...asEvent(buildAttestationTemplate({ gameCoord: COORD, ref: "sala-9", playerPubkey: winner })),
      pubkey: oracle,
    })!;
    expect(isAuthorizedAttestation(att, oracle)).toBe(true);
    expect(isAuthorizedAttestation(att, "e".repeat(64))).toBe(false); // otra clave: no vale
    expect(isAuthorizedAttestation(att, null)).toBe(false); // el juego no declaró oráculo
  });
});
