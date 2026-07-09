import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools/pure";
import {
  NGE_KIND,
  parseNgeUri,
  requestTemplate,
  responseTemplate,
  notificationTemplate,
  decryptPayload,
} from "../src/nge-core.js";

// Conformance del NÚCLEO de protocolo (src/nge-core.ts) contra los vectores
// firmados de NGE v2 (vectors/). Misma URI, mismo `content` cifrado (nonce
// fijo → determinista), mismos ids, mismo cableado req↔resp. Las firmas se
// VERIFICAN (BIP-340 lleva aux aleatorio), no se comparan. El cliente (clase
// NGE) tiene su propia conformance en tests/nge-client.test.ts.
const V = JSON.parse(
  readFileSync(new URL("../vectors/nge-test-vectors.json", import.meta.url), "utf8"),
) as any;

const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const escrowSk = hexToBytes(V.keys.escrow.sk);
const clientSk = hexToBytes(V.keys.client.sk);
const escrowPk: string = V.keys.escrow.pubkey;
const clientPk: string = V.keys.client.pubkey;
const nonce = hexToBytes(V.crypto.nonce);

// ── parseNgeUri ──────────────────────────────────────────────────────────────
describe("parseNgeUri", () => {
  it("deriva escrow/relays/clientPubkey del string mínimo de 3 campos", () => {
    const c = parseNgeUri(V.uri);
    expect(c.escrowPubkey).toBe(V.parsed.escrowPubkey);
    expect(c.relays).toEqual(V.parsed.relays);
    expect(c.clientPubkey).toBe(V.parsed.clientPubkey);
    expect(c.clientPubkey).toBe(getPublicKey(clientSk)); // = getPublicKey(secret)
  });

  it("rechaza esquema y campos faltantes", () => {
    expect(() => parseNgeUri("https://foo?x=1")).toThrow(/nostr\+nge/);
    expect(() => parseNgeUri(`nostr+nge://${escrowPk}?secret=nsec1x`)).toThrow(/relay/);
    expect(() => parseNgeUri(`nostr+nge://${escrowPk}?relay=wss://r`)).toThrow(/secret/);
  });
});

// ── Builders puros vs vectores (content + id deterministas) ──────────────────
describe("builders puros reproducen el content/id de cada par del vector", () => {
  for (const c of V.canonical) {
    it(`request de ${c.method}`, () => {
      const tmpl = requestTemplate(c.requestPayload, {
        escrowPubkey: escrowPk,
        secretKey: clientSk,
        createdAt: c.request.created_at,
        nonce,
      });
      expect(tmpl.kind).toBe(NGE_KIND.request);
      expect(tmpl.content).toBe(c.request.content);
      const ev = finalizeEvent(tmpl, clientSk);
      expect(ev.id).toBe(c.request.id); // el id (hash) es determinista aunque la firma no
      expect(ev.pubkey).toBe(clientPk); // el request lo firma `C`
    });

    it(`response de ${c.method}`, () => {
      const tmpl = responseTemplate(c.responsePayload, {
        clientPubkey: clientPk,
        requestId: c.request.id,
        secretKey: escrowSk,
        createdAt: c.response.created_at,
        nonce,
      });
      expect(tmpl.kind).toBe(NGE_KIND.response);
      expect(tmpl.content).toBe(c.response.content);
      // la response tiene que tagear el id del request y la pubkey del cliente
      expect(tmpl.tags).toContainEqual(["e", c.request.id]);
      expect(tmpl.tags).toContainEqual(["p", clientPk]);
      const ev = finalizeEvent(tmpl, escrowSk);
      expect(ev.id).toBe(c.response.id);
      expect(ev.pubkey).toBe(escrowPk); // la response la firma `S`
    });
  }
});

// ── Cifrado NIP-44 C↔S (round-trip contra el ciphertext del vector) ──────────
describe("cifrado NIP-44 simétrico C↔S", () => {
  for (const c of V.canonical) {
    it(`${c.method}: descifra request y response a sus payloads`, () => {
      // el escrow descifra el request de `C`
      expect(decryptPayload(c.request.content, escrowSk, clientPk)).toEqual(c.requestPayload);
      // el juego descifra la response de `S`
      expect(decryptPayload(c.response.content, clientSk, escrowPk)).toEqual(c.responsePayload);
    });
  }
});

// ── Firmas ───────────────────────────────────────────────────────────────────
describe("todos los eventos del vector verifican firma", () => {
  it("canónicos (request+response) + adversariales con evento firmado", () => {
    const evs: Event[] = [
      ...V.canonical.flatMap((c: any) => [c.request, c.response]),
      ...V.adversarial.filter((a: any) => a.request).map((a: any) => a.request),
    ];
    expect(evs.length).toBeGreaterThanOrEqual(10);
    for (const ev of evs) expect(verifyEvent(ev)).toBe(true);
  });
});

// ── Notification 24942 `bet_updated`: template determinista (push §9, v1.1) ──
describe("notification 24942 bet_updated", () => {
  const N = V.notifications[0];

  it("notificationTemplate reproduce content/id del vector; tag p, SIN tag e", () => {
    const tmpl = notificationTemplate(N.payload, {
      clientPubkey: clientPk,
      secretKey: escrowSk,
      createdAt: N.event.created_at,
      nonce,
    });
    expect(tmpl.kind).toBe(NGE_KIND.notification);
    expect(tmpl.content).toBe(N.event.content);
    expect(tmpl.tags).toContainEqual(["p", clientPk]);
    expect(tmpl.tags.some((t: string[]) => t[0] === "e")).toBe(false);
    const ev = finalizeEvent(tmpl, escrowSk);
    expect(ev.id).toBe(N.event.id);
    expect(ev.pubkey).toBe(escrowPk); // la notification la firma `S`
  });
});
