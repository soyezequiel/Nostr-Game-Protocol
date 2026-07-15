import { describe, expect, it, vi } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip44,
  verifyEvent,
  type Event,
  type EventTemplate,
  type Filter,
} from "nostr-tools";
import {
  BalNip46Client,
  BalNip46RemoteSession,
  parseBalBunkerUri,
  type BalNip46RelayFactory,
  type BalNip46RelayTransport,
} from "../src/bal-nip46.js";

function matches(filter: Filter, event: Event): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  const recipients = event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]);
  if (filter["#p"] && !filter["#p"].some((pubkey) => recipients.includes(pubkey))) return false;
  return true;
}

class RelayBus {
  private listeners = new Set<{ filter: Filter; handler: (event: Event) => void }>();
  readonly factory: BalNip46RelayFactory = () => {
    const own = new Set<() => void>();
    const transport: BalNip46RelayTransport = {
      publish: async (event) => {
        queueMicrotask(() => {
          for (const listener of this.listeners) if (matches(listener.filter, event)) listener.handler(event);
        });
      },
      subscribe: (filter, handler) => {
        const listener = { filter, handler };
        this.listeners.add(listener);
        const stop = () => this.listeners.delete(listener);
        own.add(stop);
        return stop;
      },
      close: () => { for (const stop of own) stop(); own.clear(); },
    };
    return transport;
  };
}

function localSigner(secretKey: Uint8Array) {
  const pubkey = getPublicKey(secretKey);
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (event: EventTemplate) => finalizeEvent(event, secretKey),
    nip04Encrypt: async (peer: string, plaintext: string) => nip04.encrypt(secretKey, peer, plaintext),
    nip04Decrypt: async (peer: string, ciphertext: string) => nip04.decrypt(secretKey, peer, ciphertext),
    nip44Encrypt: async (peer: string, plaintext: string) => nip44.encrypt(plaintext, nip44.getConversationKey(secretKey, peer)),
    nip44Decrypt: async (peer: string, ciphertext: string) => nip44.decrypt(ciphertext, nip44.getConversationKey(secretKey, peer)),
  };
}

describe("BAL NIP-46 adapter", () => {
  it("canjea una Bunker URI efímera y sólo ejecuta permisos autorizados", async () => {
    const bus = new RelayBus();
    const identitySecret = generateSecretKey();
    const identityPubkey = getPublicKey(identitySecret);
    const clientSecret = generateSecretKey();
    const client = new BalNip46Client({ clientSecret, relayFactory: bus.factory, rpcTimeoutMs: 1_000 });
    const onClosed = vi.fn();
    const remote = await BalNip46RemoteSession.create({
      clientPubkey: client.clientPubkey,
      identityPubkey,
      signer: localSigner(identitySecret),
      permissions: ["get_public_key", "sign_event:22242"],
      relays: ["wss://relay.example"],
      relayFactory: bus.factory,
      onClosed,
    });

    const bunkerUri = remote.takeBunkerUri();
    const pointer = parseBalBunkerUri(bunkerUri);
    expect(pointer.pubkey).toBe(remote.servicePubkey);
    expect(pointer.pubkey).not.toBe(identityPubkey);
    await client.open(bunkerUri);
    expect(await client.getPublicKey()).toBe(identityPubkey);

    const signed = await client.signEvent({ kind: 22242, created_at: 1, tags: [], content: "login" });
    expect(signed.pubkey).toBe(identityPubkey);
    expect(verifyEvent(signed)).toBe(true);
    await expect(client.signEvent({ kind: 1, created_at: 1, tags: [], content: "no" })).rejects.toThrow(/Permiso/);

    const replay = new BalNip46Client({ clientSecret, relayFactory: bus.factory, rpcTimeoutMs: 1_000 });
    await expect(replay.open(bunkerUri)).rejects.toThrow(/ya fue utilizada|Credencial BAL inválida/);
    await client.close();
    expect(onClosed).toHaveBeenCalledWith("client_logout");
    await replay.close();
    remote.close();
  });
});
