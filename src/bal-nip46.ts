/** NIP-46 adapters used by BAL. BAL does not replace or extend the NIP-46 wire. */
import {
  SimplePool,
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
  BAL_DEFAULT_SESSION_TTL_MS,
  BalError,
  normalizeBalPermissions,
} from "./bal-core.js";

const NIP46_KIND = 24133;
const HEX64 = /^[0-9a-f]{64}$/;

export interface BalNip46RelayTransport {
  publish(event: Event): Promise<void>;
  subscribe(filter: Filter, onEvent: (event: Event) => void): () => void;
  close(): void;
}

export type BalNip46RelayFactory = (relays: string[]) => BalNip46RelayTransport;

export function balNip46PoolTransport(relays: string[]): BalNip46RelayTransport {
  const pool = new SimplePool();
  return {
    async publish(event) {
      const attempts = pool.publish(relays, event);
      if (attempts.length === 0) throw new BalError("NIP46_ERROR", "No hay relays NIP-46");
      try { await Promise.any(attempts); } catch {
        throw new BalError("NIP46_ERROR", "Ningún relay aceptó el evento NIP-46");
      }
    },
    subscribe(filter, onEvent) {
      const sub = pool.subscribeMany(relays, filter, { onevent: onEvent });
      return () => { void sub.close(); };
    },
    close() { pool.close(relays); },
  };
}

export type BalBunkerPointer = { pubkey: string; relays: string[]; secret: string };

export function parseBalBunkerUri(uri: string): BalBunkerPointer {
  let parsed: URL;
  try { parsed = new URL(uri); } catch {
    throw new BalError("NIP46_ERROR", "Bunker URI inválida");
  }
  if (parsed.protocol !== "bunker:" || !HEX64.test(parsed.hostname)) {
    throw new BalError("NIP46_ERROR", "Bunker URI inválida");
  }
  const relays = [...new Set(parsed.searchParams.getAll("relay"))];
  if (relays.length === 0 || relays.some((relay) => {
    try { return !["ws:", "wss:"].includes(new URL(relay).protocol); } catch { return true; }
  })) {
    throw new BalError("NIP46_ERROR", "Bunker URI sin relays válidos");
  }
  const secret = parsed.searchParams.get("secret") ?? "";
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(secret)) {
    throw new BalError("NIP46_ERROR", "Bunker URI sin secret válido");
  }
  return { pubkey: parsed.hostname, relays, secret };
}

function createBunkerUri(pointer: BalBunkerPointer): string {
  const uri = new URL(`bunker://${pointer.pubkey}`);
  for (const relay of pointer.relays) uri.searchParams.append("relay", relay);
  uri.searchParams.set("secret", pointer.secret);
  return uri.toString();
}

function randomToken(): string {
  return Array.from(generateSecretKey(), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Nip46Request = { id: string; method: string; params: string[] };
type Nip46Response = { id: string; result?: string; error?: string };

function decodeJson(content: string, secretKey: Uint8Array, peerPubkey: string): unknown {
  const key = nip44.getConversationKey(secretKey, peerPubkey);
  return JSON.parse(nip44.decrypt(content, key));
}

function encodeJson(value: unknown, secretKey: Uint8Array, peerPubkey: string): string {
  const key = nip44.getConversationKey(secretKey, peerPubkey);
  return nip44.encrypt(JSON.stringify(value), key);
}

function validRpcId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(id);
}

export interface BalNip46Signer {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
  nip04Encrypt?(peerPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt?(peerPubkey: string, ciphertext: string): Promise<string>;
  nip44Encrypt?(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt?(peerPubkey: string, ciphertext: string): Promise<string>;
}

export type BalNip46RemoteSessionOptions = {
  clientPubkey: string;
  identityPubkey: string;
  signer: BalNip46Signer;
  permissions: string[];
  relays: string[];
  expiresAt?: number;
  relayFactory?: BalNip46RelayFactory;
  onRedeemed?: () => void;
};

/**
 * Remote signer efímero. Su clave sólo identifica esta sesión NIP-46; todas las
 * firmas de usuario se delegan al signer de Luna Negra y nunca sale una nsec.
 */
export class BalNip46RemoteSession {
  readonly expiresAt: number;
  readonly servicePubkey: string;
  readonly clientPubkey: string;
  readonly identityPubkey: string;
  private readonly serviceSecret: Uint8Array;
  private secret: string | null;
  private bunkerUriValue: string | null;
  private readonly transport: BalNip46RelayTransport;
  private readonly permissions: Set<string>;
  private readonly seenEvents = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private redeemed = false;
  private closed = false;

  private constructor(private readonly options: BalNip46RemoteSessionOptions) {
    if (!HEX64.test(options.clientPubkey) || !HEX64.test(options.identityPubkey)) {
      throw new BalError("NIP46_ERROR", "Pubkey inválida para la sesión BAL");
    }
    this.clientPubkey = options.clientPubkey;
    this.identityPubkey = options.identityPubkey;
    this.permissions = new Set(normalizeBalPermissions(options.permissions));
    this.serviceSecret = generateSecretKey();
    this.servicePubkey = getPublicKey(this.serviceSecret);
    this.secret = randomToken();
    this.expiresAt = options.expiresAt ?? Date.now() + BAL_DEFAULT_SESSION_TTL_MS;
    this.transport = (options.relayFactory ?? balNip46PoolTransport)(options.relays);
    this.bunkerUriValue = createBunkerUri({ pubkey: this.servicePubkey, relays: options.relays, secret: this.secret });
  }

  static async create(options: BalNip46RemoteSessionOptions): Promise<BalNip46RemoteSession> {
    const actualPubkey = await options.signer.getPublicKey();
    if (actualPubkey !== options.identityPubkey) {
      throw new BalError("NIP46_ERROR", "El signer activo no corresponde a la identidad autorizada");
    }
    const session = new BalNip46RemoteSession(options);
    session.start();
    return session;
  }

  private start(): void {
    const since = Math.floor(Date.now() / 1000) - 10;
    this.unsubscribe = this.transport.subscribe(
      { kinds: [NIP46_KIND], authors: [this.clientPubkey], "#p": [this.servicePubkey], since },
      (event) => { void this.handleEvent(event); },
    );
    this.expiryTimer = setTimeout(() => this.close(), Math.max(0, this.expiresAt - Date.now()));
  }

  /** Entrega la URI exactamente una vez y elimina la copia retenida por el servicio. */
  takeBunkerUri(): string {
    if (!this.bunkerUriValue) throw new BalError("NIP46_ERROR", "La Bunker URI BAL ya fue entregada");
    const uri = this.bunkerUriValue;
    this.bunkerUriValue = null;
    return uri;
  }

  private async handleEvent(event: Event): Promise<void> {
    if (this.closed || Date.now() >= this.expiresAt) return this.close();
    if (event.pubkey !== this.clientPubkey || !verifyEvent(event) || this.seenEvents.has(event.id)) return;
    if (Math.abs(event.created_at * 1000 - Date.now()) > 5 * 60_000) return;
    this.seenEvents.add(event.id);
    if (this.seenEvents.size > 1_000) this.seenEvents.delete(this.seenEvents.values().next().value!);

    let request: Nip46Request;
    try {
      const decoded = decodeJson(event.content, this.serviceSecret, this.clientPubkey) as Partial<Nip46Request>;
      if (!validRpcId(decoded.id) || typeof decoded.method !== "string" || !Array.isArray(decoded.params)) return;
      request = { id: decoded.id, method: decoded.method, params: decoded.params.filter((item): item is string => typeof item === "string") };
    } catch { return; }

    try {
      const result = await this.execute(request);
      await this.respond({ id: request.id, result });
    } catch (error) {
      const message = error instanceof BalError ? error.message : "Operación NIP-46 rechazada";
      await this.respond({ id: request.id, error: message.slice(0, 180) }).catch(() => {});
    }
  }

  private requirePermission(permission: string): void {
    if (!this.permissions.has(permission)) {
      throw new BalError("PERMISSION_DENIED", `Permiso NIP-46 no autorizado: ${permission}`);
    }
  }

  private async execute(request: Nip46Request): Promise<string> {
    if (request.method === "connect") {
      if (this.redeemed) throw new BalError("NIP46_ERROR", "La Bunker URI BAL ya fue utilizada");
      if (!this.secret || request.params[0] !== this.servicePubkey || request.params[1] !== this.secret) {
        throw new BalError("NIP46_ERROR", "Credencial BAL inválida");
      }
      this.secret = null;
      this.redeemed = true;
      this.options.onRedeemed?.();
      return "ack";
    }
    if (!this.redeemed) throw new BalError("NIP46_ERROR", "La sesión NIP-46 no fue conectada");
    if (request.method === "ping") return "pong";
    if (request.method === "get_public_key") {
      this.requirePermission("get_public_key");
      return this.identityPubkey;
    }
    if (request.method === "sign_event") {
      let template: EventTemplate;
      try { template = JSON.parse(request.params[0] ?? "") as EventTemplate; } catch {
        throw new BalError("NIP46_ERROR", "Evento NIP-46 inválido");
      }
      if (!Number.isInteger(template?.kind) || !Number.isInteger(template.created_at) || !Array.isArray(template.tags) || typeof template.content !== "string") {
        throw new BalError("NIP46_ERROR", "Evento NIP-46 inválido");
      }
      if (!this.permissions.has("sign_event")) this.requirePermission(`sign_event:${template.kind}`);
      const signed = await this.options.signer.signEvent(template);
      if (signed.pubkey !== this.identityPubkey || !verifyEvent(signed)) {
        throw new BalError("NIP46_ERROR", "El signer devolvió una firma inválida");
      }
      return JSON.stringify(signed);
    }
    const [peer = "", payload = ""] = request.params;
    if (!HEX64.test(peer)) throw new BalError("NIP46_ERROR", "Pubkey peer inválida");
    switch (request.method) {
      case "nip04_encrypt": this.requirePermission("nip04_encrypt"); return this.callCrypto(this.options.signer.nip04Encrypt, peer, payload);
      case "nip04_decrypt": this.requirePermission("nip04_decrypt"); return this.callCrypto(this.options.signer.nip04Decrypt, peer, payload);
      case "nip44_encrypt": this.requirePermission("nip44_encrypt"); return this.callCrypto(this.options.signer.nip44Encrypt, peer, payload);
      case "nip44_decrypt": this.requirePermission("nip44_decrypt"); return this.callCrypto(this.options.signer.nip44Decrypt, peer, payload);
      default: throw new BalError("PERMISSION_DENIED", "Método NIP-46 no autorizado");
    }
  }

  private async callCrypto(
    operation: BalNip46Signer["nip04Encrypt"] | undefined,
    peer: string,
    payload: string,
  ): Promise<string> {
    if (!operation) throw new BalError("NIP46_ERROR", "El signer activo no soporta esta operación");
    return operation.call(this.options.signer, peer, payload);
  }

  private async respond(response: Nip46Response): Promise<void> {
    if (this.closed) return;
    const event = finalizeEvent({
      kind: NIP46_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", this.clientPubkey]],
      content: encodeJson(response, this.serviceSecret, this.clientPubkey),
    }, this.serviceSecret);
    await this.transport.publish(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.transport.close();
  }
}

type PendingRpc = {
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type BalNip46ClientOptions = {
  clientSecret?: Uint8Array;
  relayFactory?: BalNip46RelayFactory;
  rpcTimeoutMs?: number;
};

/** Cliente NIP-46 efímero que consume la Bunker URI entregada por BAL. */
export class BalNip46Client implements BalNip46Signer {
  readonly clientPubkey: string;
  private readonly clientSecret: Uint8Array;
  private readonly relayFactory: BalNip46RelayFactory;
  private readonly rpcTimeoutMs: number;
  private pointer: BalBunkerPointer | null = null;
  private transport: BalNip46RelayTransport | null = null;
  private unsubscribe: (() => void) | null = null;
  private pending = new Map<string, PendingRpc>();
  private serial = 0;
  private cachedPubkey: string | null = null;

  constructor(options: BalNip46ClientOptions = {}) {
    this.clientSecret = options.clientSecret ?? generateSecretKey();
    this.clientPubkey = getPublicKey(this.clientSecret);
    this.relayFactory = options.relayFactory ?? balNip46PoolTransport;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 30_000;
  }

  async open(bunkerUri: string): Promise<void> {
    if (this.transport) throw new BalError("NIP46_ERROR", "El cliente BAL ya está conectado");
    this.pointer = parseBalBunkerUri(bunkerUri);
    this.transport = this.relayFactory(this.pointer.relays);
    this.unsubscribe = this.transport.subscribe(
      { kinds: [NIP46_KIND], authors: [this.pointer.pubkey], "#p": [this.clientPubkey], since: Math.floor(Date.now() / 1000) - 10 },
      (event) => this.handleResponse(event),
    );
    await this.rpc("connect", [this.pointer.pubkey, this.pointer.secret]);
    this.pointer.secret = "";
  }

  private handleResponse(event: Event): void {
    if (!this.pointer || event.pubkey !== this.pointer.pubkey || !verifyEvent(event)) return;
    let response: Nip46Response;
    try { response = decodeJson(event.content, this.clientSecret, this.pointer.pubkey) as Nip46Response; } catch { return; }
    if (!validRpcId(response.id)) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (typeof response.error === "string" && response.error) pending.reject(new BalError("NIP46_ERROR", response.error));
    else if (typeof response.result === "string") pending.resolve(response.result);
    else pending.reject(new BalError("NIP46_ERROR", "Respuesta NIP-46 inválida"));
  }

  private rpc(method: string, params: string[]): Promise<string> {
    if (!this.pointer || !this.transport) return Promise.reject(new BalError("NIP46_ERROR", "Cliente NIP-46 cerrado"));
    const id = `bal-${this.clientPubkey.slice(0, 8)}-${++this.serial}`;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BalError("NIP46_ERROR", `Timeout NIP-46 en ${method}`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const event = finalizeEvent({
        kind: NIP46_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", this.pointer!.pubkey]],
        content: encodeJson({ id, method, params }, this.clientSecret, this.pointer!.pubkey),
      }, this.clientSecret);
      this.transport!.publish(event).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async getPublicKey(): Promise<string> {
    this.cachedPubkey ??= await this.rpc("get_public_key", []);
    if (!HEX64.test(this.cachedPubkey)) throw new BalError("NIP46_ERROR", "Pubkey NIP-46 inválida");
    return this.cachedPubkey;
  }

  async signEvent(event: EventTemplate): Promise<Event> {
    const raw = await this.rpc("sign_event", [JSON.stringify(event)]);
    const signed = JSON.parse(raw) as Event;
    if (!verifyEvent(signed)) throw new BalError("NIP46_ERROR", "Firma NIP-46 inválida");
    return signed;
  }

  nip04Encrypt(peer: string, plaintext: string): Promise<string> { return this.rpc("nip04_encrypt", [peer, plaintext]); }
  nip04Decrypt(peer: string, ciphertext: string): Promise<string> { return this.rpc("nip04_decrypt", [peer, ciphertext]); }
  nip44Encrypt(peer: string, plaintext: string): Promise<string> { return this.rpc("nip44_encrypt", [peer, plaintext]); }
  nip44Decrypt(peer: string, ciphertext: string): Promise<string> { return this.rpc("nip44_decrypt", [peer, ciphertext]); }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.transport?.close();
    this.transport = null;
    this.pointer = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BalError("NIP46_ERROR", "Sesión NIP-46 cerrada"));
    }
    this.pending.clear();
  }
}
