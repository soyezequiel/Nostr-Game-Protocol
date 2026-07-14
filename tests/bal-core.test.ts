import { describe, expect, it } from "vitest";
import {
  BAL_PROTOCOL,
  BAL_VERSION,
  BalError,
  MemoryBalAuthorizationStore,
  balAuthorizationId,
  createBalAuthorization,
  matchesBalAuthorization,
  normalizeBalPermissions,
  parseBalMessage,
  parseBalReady,
  parseBalSession,
} from "../src/bal-core.js";

const ready = {
  protocol: BAL_PROTOCOL,
  version: BAL_VERSION,
  type: "BAL_READY",
  requestId: "request-12345678",
  nonce: "nonce-12345678",
  gameId: "ajedrez",
  clientPubkey: "ab".repeat(32),
  requestedPermissions: ["sign_event:22242", "get_public_key"],
};

describe("BAL wire validation", () => {
  it("normaliza un BAL_READY válido sin permitir que el juego elija usuario", () => {
    const parsed = parseBalReady(ready);
    expect(parsed.requestedPermissions).toEqual(["get_public_key", "sign_event:22242"]);
    expect(parsed).not.toHaveProperty("userPubkey");
    expect(parseBalMessage(ready)).toEqual(parsed);
  });

  it("rechaza versión, pubkey, permisos y sesiones vencidas", () => {
    expect(() => parseBalReady({ ...ready, version: 2 })).toThrowError(BalError);
    expect(() => parseBalReady({ ...ready, clientPubkey: "bad" })).toThrow(/clientPubkey/);
    expect(() => normalizeBalPermissions(["admin", "get_public_key"])).toThrow(/permisos/);
    expect(() => parseBalSession({
      ...ready,
      type: "BAL_SESSION",
      bunkerUri: `bunker://${"cd".repeat(32)}?relay=wss%3A%2F%2Frelay&secret=1234567890123456`,
      expiresAt: 99,
    }, 100)).toThrow(/expiró/);
  });
});

describe("BAL remembered consent", () => {
  const consent = {
    gameId: "ajedrez",
    gameName: "Ajedrez",
    origin: "https://chess.example",
    identityId: "user-1",
    pubkey: "12".repeat(32),
    identitySource: "nsec" as const,
    permissions: ["get_public_key", "sign_event:22242"],
  };

  it("queda ligado a juego, origen, usuario, firmante y permisos", () => {
    const auth = createBalAuthorization(consent, 1_000, 5_000);
    expect(auth.id).toBe(balAuthorizationId(consent));
    expect(matchesBalAuthorization(auth, consent, 2_000)).toBe(true);
    expect(matchesBalAuthorization(auth, { ...consent, origin: "https://evil.example" }, 2_000)).toBe(false);
    expect(matchesBalAuthorization(auth, { ...consent, pubkey: "34".repeat(32) }, 2_000)).toBe(false);
    expect(matchesBalAuthorization(auth, { ...consent, identitySource: "nip07" }, 2_000)).toBe(false);
    expect(matchesBalAuthorization(auth, { ...consent, permissions: [...consent.permissions, "sign_event:1"] }, 2_000)).toBe(false);
    expect(matchesBalAuthorization(auth, consent, 6_000)).toBe(false);
  });

  it("provee un store in-memory para launchers no web y tests", () => {
    const store = new MemoryBalAuthorizationStore();
    const auth = createBalAuthorization(consent);
    store.save(auth);
    expect(store.list()).toEqual([auth]);
    store.remove(auth.id);
    expect(store.list()).toEqual([]);
  });
});
