import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Event, EventTemplate } from "nostr-tools";
import {
  createPresenceManager,
  NGP_KIND,
  NGP_PRESENCE_DEFAULT_MIN_RESIGN_MS,
  type NgpPresenceStorage,
  type NgpSigner,
} from "../src/ngp.js";

// Orquestación de presencia NIP-38 (src/ngp-presence.ts): heartbeat, throttle de
// firma (en memoria y persistido), clear pre-firmado del cierre y clear de logout.
// El WIRE del evento se cubre en ngp-core.test.ts; acá se cubre el CICLO DE VIDA.

const COORD = "30023:" + "a".repeat(64) + ":tetra";
const TTL = 180;

function localSigner(): { signer: NgpSigner; pubkey: string } {
  const sk = generateSecretKey();
  return {
    pubkey: getPublicKey(sk),
    signer: {
      getPublicKey: async () => getPublicKey(sk),
      signEvent: async (t: EventTemplate) => finalizeEvent(t, sk),
    },
  };
}

function memoryStorage(): NgpPresenceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** Deja correr los microtasks del beat en curso (firma + publish son async). */
const flush = () => vi.advanceTimersByTimeAsync(0);

function harness(overrides: { storage?: NgpPresenceStorage; pubkey?: string } = {}) {
  const { signer, pubkey } = localSigner();
  const published: Event[] = [];
  const publishedSync: Event[] = [];
  const manager = createPresenceManager({
    signer,
    gameCoord: COORD,
    ttlSec: TTL,
    publish: async (evt) => void published.push(evt),
    publishSync: (evt) => void publishedSync.push(evt),
    pubkey: overrides.pubkey ?? pubkey,
    storage: overrides.storage ?? null,
  });
  return { manager, published, publishedSync, pubkey };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPresenceManager", () => {
  it("start(): firma y publica la presencia anclada, con TTL y d=general", async () => {
    const { manager, published } = harness();
    manager.start("Jugando TETRA");
    await flush();

    expect(published).toHaveLength(1);
    const evt = published[0];
    expect(evt.kind).toBe(NGP_KIND.presence);
    expect(evt.content).toBe("Jugando TETRA");
    expect(evt.tags).toContainEqual(["a", COORD]);
    expect(evt.tags).toContainEqual(["d", "general"]);
    expect(evt.tags).toContainEqual(["expiration", String(evt.created_at + TTL)]);
    expect(manager.isRunning()).toBe(true);
  });

  it("heartbeat: no re-firma fresco, re-firma pasado minResignMs", async () => {
    const { manager, published } = harness();
    manager.start("Jugando TETRA");
    await flush();
    expect(published).toHaveLength(1);

    // Latidos con la presencia fresca: silencio (cada firma puede ser un prompt).
    await vi.advanceTimersByTimeAsync(NGP_PRESENCE_DEFAULT_MIN_RESIGN_MS - 5_000);
    expect(published).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000); // ya pasó el mínimo entre firmas
    expect(published).toHaveLength(2);
    expect(published[1].content).toBe("Jugando TETRA");
  });

  it("setMessage(): cambio de estado re-firma YA; mismo mensaje no", async () => {
    const { manager, published } = harness();
    manager.start("En TETRA");
    await flush();

    manager.setMessage("En TETRA"); // sin cambio: el throttle lo frena
    await flush();
    expect(published).toHaveLength(1);

    manager.setMessage("Jugando TETRA"); // cambio real: sin esperar el mínimo
    await flush();
    expect(published).toHaveLength(2);
    expect(published[1].content).toBe("Jugando TETRA");
  });

  it("start() es idempotente: re-llamar con el mismo mensaje no duplica firmas ni timers", async () => {
    const { manager, published } = harness();
    manager.start("En TETRA");
    await flush();
    manager.start("En TETRA");
    await flush();
    expect(published).toHaveLength(1);
  });

  it("throttle persistido: tras un reload con el evento aún fresco NO re-firma", async () => {
    const storage = memoryStorage();
    const first = harness({ storage });
    first.manager.start("En TETRA");
    await flush();
    expect(first.published).toHaveLength(1);

    // "Reload": manager nuevo, mismo storage y misma cuenta, 10s después.
    await vi.advanceTimersByTimeAsync(10_000);
    const second = harness({ storage, pubkey: first.pubkey });
    second.manager.start("En TETRA");
    await flush();
    expect(second.published).toHaveLength(0); // sin firma = sin popup en el reload

    // Pero el heartbeat re-anuncia cuando el evento envejece.
    await vi.advanceTimersByTimeAsync(NGP_PRESENCE_DEFAULT_MIN_RESIGN_MS);
    expect(second.published).toHaveLength(1);
  });

  it("throttle persistido: estado de OTRA cuenta o mensaje distinto no frena la firma", async () => {
    const storage = memoryStorage();
    const first = harness({ storage });
    first.manager.start("En TETRA");
    await flush();

    const otherAccount = harness({ storage, pubkey: "b".repeat(64) });
    otherAccount.manager.start("En TETRA");
    await flush();
    expect(otherAccount.published).toHaveLength(1);

    const otherMessage = harness({ storage, pubkey: first.pubkey });
    otherMessage.manager.start("Jugando TETRA");
    await flush();
    expect(otherMessage.published).toHaveLength(1);
  });

  it("clearNow(): despacha el clear PRE-firmado por la vía sincrónica y conserva el storage", async () => {
    const storage = memoryStorage();
    const { manager, published, publishedSync } = harness({ storage });
    manager.start("Jugando TETRA");
    await flush();

    manager.clearNow();
    expect(publishedSync).toHaveLength(1);
    const clear = publishedSync[0];
    expect(clear.kind).toBe(NGP_KIND.presence);
    expect(clear.content).toBe("");
    expect(clear.tags).toContainEqual(["a", COORD]);
    // `created_at`+1: gana la resolución del slot replaceable d=general.
    expect(clear.created_at).toBe(published[0].created_at + 1);
    expect(manager.isRunning()).toBe(false);
    // El throttle persistido sobrevive: es lo que evita re-firmar en el reload.
    expect(storage.data.size).toBe(1);
  });

  it("stop(): publica un clear fresco, corta el heartbeat y olvida el estado persistido", async () => {
    const storage = memoryStorage();
    const { manager, published } = harness({ storage });
    manager.start("Jugando TETRA");
    await flush();

    await manager.stop();
    expect(published).toHaveLength(2);
    const clear = published[1];
    expect(clear.content).toBe("");
    expect(clear.tags).toContainEqual(["a", COORD]);
    expect(manager.isRunning()).toBe(false);
    expect(storage.data.size).toBe(0);

    // El heartbeat quedó cortado de verdad.
    await vi.advanceTimersByTimeAsync(NGP_PRESENCE_DEFAULT_MIN_RESIGN_MS * 3);
    expect(published).toHaveLength(2);
  });

  it("firmante que falla: nunca lanza, aplica cooldown y se recupera", async () => {
    let fail = true;
    const { signer } = localSigner();
    const published: Event[] = [];
    const manager = createPresenceManager({
      signer: {
        ...signer,
        signEvent: async (t) => {
          if (fail) throw new Error("rechazado");
          return signer.signEvent(t);
        },
      },
      gameCoord: COORD,
      publish: async (evt) => void published.push(evt),
    });

    manager.start("En TETRA");
    await flush();
    expect(published).toHaveLength(0);

    // Cooldown: el siguiente latido NO reintenta (sería un prompt por latido).
    await vi.advanceTimersByTimeAsync(20_000);
    expect(published).toHaveLength(0);

    fail = false;
    await vi.advanceTimersByTimeAsync(NGP_PRESENCE_DEFAULT_MIN_RESIGN_MS);
    expect(published).toHaveLength(1);
  });

  it("publish que falla: no adopta el estado (el próximo latido elegible reintenta)", async () => {
    const storage = memoryStorage();
    const { signer, pubkey } = localSigner();
    let fail = true;
    const published: Event[] = [];
    const manager = createPresenceManager({
      signer,
      gameCoord: COORD,
      pubkey,
      storage,
      publish: async (evt) => {
        if (fail) throw new Error("ningún relay aceptó");
        published.push(evt);
      },
    });

    manager.start("En TETRA");
    await flush();
    expect(storage.data.size).toBe(0); // nada salió: nada que persistir

    fail = false;
    await vi.advanceTimersByTimeAsync(NGP_PRESENCE_DEFAULT_MIN_RESIGN_MS);
    expect(published).toHaveLength(1);
    expect(storage.data.size).toBe(1);
  });
});
