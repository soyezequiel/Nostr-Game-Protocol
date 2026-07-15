import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type Filter } from "nostr-tools";
import { BalGameClient } from "../src/bal-client.js";
import { MemoryBalAuthorizationStore, type BalMessage, type BalTransport, type BalTransportEnvelope } from "../src/bal-core.js";
import { BalLauncher } from "../src/bal-launcher.js";
import type { BalNip46RelayFactory } from "../src/bal-nip46.js";

type Peer = { id: string };

class MessageHub {
  private endpoints = new Map<Peer, MessageEndpoint>();
  add(peer: Peer, origin: string): MessageEndpoint {
    const endpoint = new MessageEndpoint(this, peer, origin);
    this.endpoints.set(peer, endpoint);
    return endpoint;
  }
  deliver(sender: MessageEndpoint, target: Peer, targetOrigin: string, data: BalMessage): void {
    const endpoint = this.endpoints.get(target);
    if (!endpoint || endpoint.origin !== targetOrigin) throw new Error("targetOrigin mismatch");
    queueMicrotask(() => endpoint.receive({ data, origin: sender.origin, peer: sender.peer }));
  }
}

class MessageEndpoint implements BalTransport<Peer> {
  private handlers = new Set<(event: BalTransportEnvelope<Peer>) => void>();
  constructor(private hub: MessageHub, readonly peer: Peer, readonly origin: string) {}
  send(peer: Peer, targetOrigin: string, message: BalMessage): void { this.hub.deliver(this, peer, targetOrigin, message); }
  subscribe(handler: (event: BalTransportEnvelope<Peer>) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  receive(event: BalTransportEnvelope<Peer>): void { for (const handler of this.handlers) handler(event); }
}

function matches(filter: Filter, event: Event): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  const recipients = event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]);
  return !filter["#p"] || filter["#p"].some((pubkey) => recipients.includes(pubkey));
}

function relayFactory(): BalNip46RelayFactory {
  const listeners = new Set<{ filter: Filter; handler: (event: Event) => void }>();
  return () => {
    const own = new Set<() => void>();
    return {
      publish: async (event: Event) => queueMicrotask(() => {
        for (const listener of listeners) if (matches(listener.filter, event)) listener.handler(event);
      }),
      subscribe: (filter: Filter, handler: (event: Event) => void) => {
        const listener = { filter, handler };
        listeners.add(listener);
        const stop = () => listeners.delete(listener);
        own.add(stop);
        return stop;
      },
      close: () => { for (const stop of own) stop(); },
    };
  };
}

describe("BAL game ↔ launcher flow", () => {
  it("pide consentimiento una vez, recuerda el binding y entrega la pubkey por NIP-46", async () => {
    const hub = new MessageHub();
    const launcherPeer = { id: "launcher" };
    const gamePeer = { id: "game" };
    const launcherOrigin = "https://luna.example";
    const gameOrigin = "https://chess.example";
    const launcherTransport = hub.add(launcherPeer, launcherOrigin);
    const gameTransport = hub.add(gamePeer, gameOrigin);
    const relays = relayFactory();
    const identitySecret = generateSecretKey();
    const identityPubkey = getPublicKey(identitySecret);
    const authorizations = new MemoryBalAuthorizationStore();
    let consentPrompts = 0;
    const onSessionClosed = vi.fn();

    const launcher = new BalLauncher({
      transport: launcherTransport,
      registry: {
        resolve(envelope, gameId) {
          return envelope.peer === gamePeer && envelope.origin === gameOrigin && gameId === "ajedrez"
            ? { gameId, gameName: "Ajedrez", origin: gameOrigin, peer: gamePeer }
            : null;
        },
      },
      authorizationStore: authorizations,
      relays: ["wss://relay.example"],
      relayFactory: relays,
      getIdentity: () => ({
        identityId: "user-1",
        pubkey: identityPubkey,
        source: "nip07" as const,
        signer: {
          getPublicKey: async () => identityPubkey,
          signEvent: async (event) => finalizeEvent(event, identitySecret),
        },
      }),
      requestConsent: async () => { consentPrompts += 1; return "remember" as const; },
      onSessionClosed,
    });
    launcher.start();

    const makeClient = () => new BalGameClient({
      gameId: "ajedrez",
      requestedPermissions: ["get_public_key", "sign_event:22242"],
      launcherOrigin,
      launcherPeer,
      transport: gameTransport,
      nip46: { relayFactory: relays, rpcTimeoutMs: 1_000 },
      timeoutMs: 2_000,
    });
    const first = makeClient();
    const firstLogin = await first.login();
    expect(firstLogin.pubkey).toBe(identityPubkey);
    expect(consentPrompts).toBe(1);
    expect(authorizations.list()).toHaveLength(1);

    const second = makeClient();
    const secondLogin = await second.login();
    expect(secondLogin.pubkey).toBe(identityPubkey);
    expect(consentPrompts).toBe(1);

    // Simula al SharedWorker cerrando su cliente cuando desaparece la última
    // pestaña: no queda una Window desde la que mandar BAL_LOGOUT.
    await firstLogin.signer.close();
    await vi.waitFor(() => expect(onSessionClosed).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: expect.stringMatching(/^request-/),
        gameId: "ajedrez",
        gameName: "Ajedrez",
        origin: gameOrigin,
      }),
      "client_logout",
    ));

    await first.logout();
    await second.logout();
    launcher.stop();
  });
});
