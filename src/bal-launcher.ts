import {
  BAL_PROTOCOL,
  BAL_VERSION,
  BalError,
  balErrorMessage,
  createBalAuthorization,
  matchesBalAuthorization,
  parseBalLogout,
  parseBalReady,
  type BalAuthorizationStore,
  type BalConsentDecision,
  type BalConsentRequest,
  type BalIdentitySource,
  type BalSessionMessage,
  type BalTransport,
  type BalTransportEnvelope,
} from "./bal-core.js";
import {
  BalNip46RemoteSession,
  type BalNip46RelayFactory,
  type BalNip46Signer,
} from "./bal-nip46.js";

export type BalLauncherGame<Peer> = {
  gameId: string;
  gameName: string;
  origin: string;
  peer: Peer;
};

export interface BalGameRegistry<Peer> {
  resolve(envelope: BalTransportEnvelope<Peer>, gameId: string): BalLauncherGame<Peer> | null;
}

export type BalLauncherIdentity = {
  identityId: string;
  pubkey: string;
  source: BalIdentitySource;
  signer: BalNip46Signer;
};

export type BalLauncherSession = {
  bunkerUri: string;
  expiresAt: number;
  close(): void;
};

export type BalLauncherOptions<Peer> = {
  transport: BalTransport<Peer>;
  registry: BalGameRegistry<Peer>;
  authorizationStore: BalAuthorizationStore;
  getIdentity(): Promise<BalLauncherIdentity | null> | BalLauncherIdentity | null;
  requestConsent(request: BalConsentRequest): Promise<BalConsentDecision>;
  relays: string[];
  relayFactory?: BalNip46RelayFactory;
  authorizationTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
};

type ActiveSession<Peer> = Omit<BalLauncherSession, "bunkerUri"> & {
  requestId: string;
  nonce: string;
  peer: Peer;
  origin: string;
  authorizationId: string;
};

/** Launcher-side coordinator with source/origin validation and replay defense. */
export class BalLauncher<Peer> {
  private readonly active = new Map<string, ActiveSession<Peer>>();
  private readonly seenRequests = new Map<string, number>();
  private readonly seenNonces = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: BalLauncherOptions<Peer>) {}

  start(): () => void {
    if (this.unsubscribe) return () => this.stop();
    this.unsubscribe = this.options.transport.subscribe((envelope) => { void this.handle(envelope); });
    return () => this.stop();
  }

  private async handle(envelope: BalTransportEnvelope<Peer>): Promise<void> {
    const candidate = envelope.data as { type?: unknown } | null;
    if (!candidate || typeof candidate !== "object") return;
    if (candidate.type === "BAL_LOGOUT") return this.handleLogout(envelope);
    if (candidate.type !== "BAL_READY") return;

    let ready;
    try { ready = parseBalReady(candidate); } catch { return; }
    const game = this.options.registry.resolve(envelope, ready.gameId);
    if (!game) return this.sendError(envelope, ready, "UNREGISTERED_GAME", "El juego no está registrado para BAL");
    if (game.origin !== envelope.origin) return this.sendError(envelope, ready, "ORIGIN_MISMATCH", "El origen del juego no coincide");
    if (game.peer !== envelope.peer) return this.sendError(envelope, ready, "SOURCE_MISMATCH", "La ventana del juego no coincide");

    const now = this.options.now?.() ?? Date.now();
    this.pruneReplay(now);
    if (this.seenRequests.has(ready.requestId) || this.seenNonces.has(ready.nonce)) {
      return this.sendError(envelope, ready, "DUPLICATE_REQUEST", "Solicitud BAL duplicada");
    }
    const replayUntil = now + (this.options.sessionTtlMs ?? 8 * 60 * 60_000);
    this.seenRequests.set(ready.requestId, replayUntil);
    this.seenNonces.set(ready.nonce, replayUntil);

    let identity;
    try { identity = await this.options.getIdentity(); } catch {
      return this.sendError(envelope, ready, "NO_ACTIVE_IDENTITY", "No se pudo obtener la identidad activa");
    }
    if (!identity) return this.sendError(envelope, ready, "NO_ACTIVE_IDENTITY", "Luna Negra no tiene una identidad BAL activa");
    if (identity.source !== "email" && identity.source !== "nsec") {
      return this.sendError(envelope, ready, "IDENTITY_NOT_ELIGIBLE", "La identidad activa no admite BAL");
    }
    const consent: BalConsentRequest = {
      gameId: game.gameId,
      gameName: game.gameName,
      origin: game.origin,
      identityId: identity.identityId,
      pubkey: identity.pubkey,
      identitySource: identity.source,
      permissions: ready.requestedPermissions,
    };
    const records = await this.options.authorizationStore.list();
    const remembered = records.find((record) => matchesBalAuthorization(record, consent, now));
    let decision: BalConsentDecision;
    try { decision = remembered ? "remember" : await this.options.requestConsent(consent); } catch {
      return this.sendError(envelope, ready, "USER_REJECTED", "No se obtuvo consentimiento BAL");
    }
    if (decision === "deny") return this.sendError(envelope, ready, "USER_REJECTED", "El usuario rechazó el acceso BAL");

    try {
      const expiresAt = now + (this.options.sessionTtlMs ?? 8 * 60 * 60_000);
      const remote = await BalNip46RemoteSession.create({
        clientPubkey: ready.clientPubkey,
        identityPubkey: identity.pubkey,
        signer: identity.signer,
        permissions: ready.requestedPermissions,
        relays: this.options.relays,
        relayFactory: this.options.relayFactory,
        expiresAt,
      });
      const bunkerUri = remote.takeBunkerUri();
      const authorization = remembered ?? createBalAuthorization(consent, now, this.options.authorizationTtlMs);
      if (decision === "remember" && !remembered) await this.options.authorizationStore.save(authorization);
      const session: ActiveSession<Peer> = {
        expiresAt,
        close: () => remote.close(),
        requestId: ready.requestId,
        nonce: ready.nonce,
        peer: envelope.peer,
        origin: envelope.origin,
        authorizationId: authorization.id,
      };
      this.active.set(ready.requestId, session);
      const message: BalSessionMessage = {
        protocol: BAL_PROTOCOL,
        version: BAL_VERSION,
        type: "BAL_SESSION",
        requestId: ready.requestId,
        nonce: ready.nonce,
        bunkerUri,
        expiresAt,
      };
      await this.options.transport.send(envelope.peer, envelope.origin, message);
    } catch (error) {
      await this.sendError(envelope, ready, "NIP46_ERROR", error instanceof BalError ? error.message : "No se pudo crear la sesión NIP-46");
    }
  }

  private async handleLogout(envelope: BalTransportEnvelope<Peer>): Promise<void> {
    let message;
    try { message = parseBalLogout(envelope.data); } catch { return; }
    const session = this.active.get(message.requestId);
    if (!session || session.peer !== envelope.peer || session.origin !== envelope.origin || session.nonce !== message.nonce) return;
    session.close();
    this.active.delete(message.requestId);
  }

  private async sendError(
    envelope: BalTransportEnvelope<Peer>,
    request: { requestId: string; nonce: string },
    code: Parameters<typeof balErrorMessage>[1],
    message: string,
  ): Promise<void> {
    try { await this.options.transport.send(envelope.peer, envelope.origin, balErrorMessage(request, code, message)); } catch { /* no secret-bearing logs */ }
  }

  private pruneReplay(now: number): void {
    for (const [key, expiresAt] of this.seenRequests) if (expiresAt <= now) this.seenRequests.delete(key);
    for (const [key, expiresAt] of this.seenNonces) if (expiresAt <= now) this.seenNonces.delete(key);
  }

  async revokeAuthorization(authorizationId: string): Promise<void> {
    await this.options.authorizationStore.remove(authorizationId);
    for (const [requestId, session] of this.active) {
      if (session.authorizationId !== authorizationId) continue;
      try {
        await this.options.transport.send(session.peer, session.origin, {
          protocol: BAL_PROTOCOL,
          version: BAL_VERSION,
          type: "BAL_LOGOUT",
          requestId: session.requestId,
          nonce: session.nonce,
          reason: "revoked",
        });
      } catch { /* best effort */ }
      session.close();
      this.active.delete(requestId);
    }
  }

  async logoutAll(reason: "launcher_logout" | "revoked" | "expired" = "launcher_logout"): Promise<void> {
    await Promise.all([...this.active.values()].map(async (session) => {
      try {
        await this.options.transport.send(session.peer, session.origin, {
          protocol: BAL_PROTOCOL,
          version: BAL_VERSION,
          type: "BAL_LOGOUT",
          requestId: session.requestId,
          nonce: session.nonce,
          reason,
        });
      } catch { /* best effort */ }
      session.close();
    }));
    this.active.clear();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const session of this.active.values()) session.close();
    this.active.clear();
  }
}
