import {
  BAL_PROTOCOL,
  BAL_VERSION,
  BalError,
  normalizeBalPermissions,
  parseBalError,
  parseBalLogout,
  parseBalSession,
  type BalLogoutMessage,
  type BalReadyMessage,
  type BalTransport,
} from "./bal-core.js";
import { BalNip46Client, type BalNip46ClientOptions } from "./bal-nip46.js";

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export type BalGameClientOptions<Peer> = {
  gameId: string;
  requestedPermissions: string[];
  launcherOrigin: string;
  launcherPeer: Peer;
  transport: BalTransport<Peer>;
  timeoutMs?: number;
  nip46?: BalNip46ClientOptions;
  onLauncherLogout?: (reason: BalLogoutMessage["reason"]) => void;
};

export type BalGameLogin = {
  pubkey: string;
  signer: BalNip46Client;
  expiresAt: number;
};

/** High-level game client: BAL_READY → BAL_SESSION → NIP-46 get_public_key. */
export class BalGameClient<Peer> {
  readonly clientPubkey: string;
  private readonly nip46: BalNip46Client;
  private readonly permissions: string[];
  private readonly requestId = randomId("request");
  private readonly nonce = randomId("nonce");
  private unsubscribe: (() => void) | null = null;
  private settled = false;

  constructor(private readonly options: BalGameClientOptions<Peer>) {
    if (!options.launcherOrigin || options.launcherOrigin === "*") {
      throw new BalError("TRANSPORT_ERROR", "BAL necesita el origen exacto del launcher");
    }
    this.permissions = normalizeBalPermissions(options.requestedPermissions);
    this.nip46 = new BalNip46Client(options.nip46);
    this.clientPubkey = this.nip46.clientPubkey;
  }

  async login(): Promise<BalGameLogin> {
    if (this.unsubscribe || this.settled) throw new BalError("DUPLICATE_REQUEST", "El login BAL ya fue iniciado");
    const ready: BalReadyMessage = {
      protocol: BAL_PROTOCOL,
      version: BAL_VERSION,
      type: "BAL_READY",
      requestId: this.requestId,
      nonce: this.nonce,
      gameId: this.options.gameId,
      clientPubkey: this.clientPubkey,
      requestedPermissions: this.permissions,
    };

    return new Promise<BalGameLogin>((resolve, reject) => {
      const finish = (fn: () => void) => {
        if (this.settled) return;
        this.settled = true;
        clearTimeout(timer);
        this.unsubscribe?.();
        this.unsubscribe = null;
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new BalError("NOT_AVAILABLE", "El launcher no respondió a BAL"))),
        this.options.timeoutMs ?? 2 * 60_000,
      );

      this.unsubscribe = this.options.transport.subscribe((envelope) => {
        if (envelope.peer !== this.options.launcherPeer || envelope.origin !== this.options.launcherOrigin) return;
        const candidate = envelope.data as { type?: unknown; requestId?: unknown; nonce?: unknown } | null;
        if (!candidate || candidate.requestId !== this.requestId || candidate.nonce !== this.nonce) return;
        if (candidate.type === "BAL_ERROR") {
          try {
            const error = parseBalError(candidate);
            finish(() => reject(new BalError(error.code, error.message)));
          } catch { /* mensaje inválido: no consume la solicitud legítima */ }
          return;
        }
        if (candidate.type === "BAL_LOGOUT") {
          try {
            parseBalLogout(candidate);
            finish(() => reject(new BalError("NOT_AVAILABLE", "El launcher cerró la sesión BAL")));
          } catch { /* noop */ }
          return;
        }
        if (candidate.type !== "BAL_SESSION") return;
        let session;
        try { session = parseBalSession(candidate); } catch (error) {
          finish(() => reject(error));
          return;
        }
        void this.nip46.open(session.bunkerUri)
          .then(() => this.nip46.getPublicKey())
          .then((pubkey) => finish(() => {
            this.listenForLauncherLogout();
            resolve({ pubkey, signer: this.nip46, expiresAt: session.expiresAt });
          }))
          .catch((error) => finish(() => reject(error)));
      });

      Promise.resolve(this.options.transport.send(this.options.launcherPeer, this.options.launcherOrigin, ready))
        .catch((error) => finish(() => reject(new BalError("TRANSPORT_ERROR", "No se pudo enviar BAL_READY", error))));
    });
  }

  private listenForLauncherLogout(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.options.transport.subscribe((envelope) => {
      if (envelope.peer !== this.options.launcherPeer || envelope.origin !== this.options.launcherOrigin) return;
      try {
        const message = parseBalLogout(envelope.data);
        if (message.requestId !== this.requestId || message.nonce !== this.nonce) return;
        this.unsubscribe?.();
        this.unsubscribe = null;
        void this.nip46.close();
        this.options.onLauncherLogout?.(message.reason);
      } catch { /* ignorar mensajes ajenos o inválidos */ }
    });
  }

  async logout(reason: BalLogoutMessage["reason"] = "game_logout"): Promise<void> {
    const message: BalLogoutMessage = {
      protocol: BAL_PROTOCOL,
      version: BAL_VERSION,
      type: "BAL_LOGOUT",
      requestId: this.requestId,
      nonce: this.nonce,
      reason,
    };
    try { await this.options.transport.send(this.options.launcherPeer, this.options.launcherOrigin, message); } catch { /* best effort */ }
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.nip46.close();
  }
}
