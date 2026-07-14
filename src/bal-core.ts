/**
 * Bunker Auto Login (BAL) v1 — núcleo puro del protocolo.
 *
 * BAL sólo negocia transporte y autorización. La identidad y las operaciones
 * criptográficas siguen viajando por NIP-46; este módulo no conoce DOM, relays
 * ni claves privadas.
 */

export const BAL_PROTOCOL = "org.nostr.bunker-auto-login" as const;
export const BAL_VERSION = 1 as const;
export const BAL_DEFAULT_AUTHORIZATION_TTL_MS = 30 * 24 * 60 * 60_000;
export const BAL_DEFAULT_SESSION_TTL_MS = 8 * 60 * 60_000;

export type BalMessageType = "BAL_READY" | "BAL_SESSION" | "BAL_ERROR" | "BAL_LOGOUT";

type BalMessageBase = {
  protocol: typeof BAL_PROTOCOL;
  version: typeof BAL_VERSION;
  type: BalMessageType;
  requestId: string;
  nonce: string;
};

export type BalReadyMessage = BalMessageBase & {
  type: "BAL_READY";
  gameId: string;
  clientPubkey: string;
  requestedPermissions: string[];
};

export type BalSessionMessage = BalMessageBase & {
  type: "BAL_SESSION";
  bunkerUri: string;
  /** Unix timestamp en milisegundos. */
  expiresAt: number;
};

export type BalErrorCode =
  | "NOT_AVAILABLE"
  | "INVALID_MESSAGE"
  | "UNSUPPORTED_VERSION"
  | "UNREGISTERED_GAME"
  | "ORIGIN_MISMATCH"
  | "SOURCE_MISMATCH"
  | "NO_ACTIVE_IDENTITY"
  | "IDENTITY_NOT_ELIGIBLE"
  | "USER_REJECTED"
  | "DUPLICATE_REQUEST"
  | "EXPIRED"
  | "PERMISSION_DENIED"
  | "NIP46_ERROR"
  | "TRANSPORT_ERROR"
  | "INTERNAL_ERROR";

export type BalErrorMessage = BalMessageBase & {
  type: "BAL_ERROR";
  code: BalErrorCode;
  message: string;
};

export type BalLogoutMessage = BalMessageBase & {
  type: "BAL_LOGOUT";
  reason?: "game_logout" | "launcher_logout" | "revoked" | "expired";
};

export type BalMessage = BalReadyMessage | BalSessionMessage | BalErrorMessage | BalLogoutMessage;

export class BalError extends Error {
  constructor(
    public readonly code: BalErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BalError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9._:-]{8,160}$/;
const GAME_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const PERMISSION = /^(get_public_key|sign_event(?::\d{1,10})?|nip0?4_(?:encrypt|decrypt)|nip44_(?:encrypt|decrypt))$/;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BalError("INVALID_MESSAGE", "El mensaje BAL debe ser un objeto");
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, field: string, pattern = TOKEN): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new BalError("INVALID_MESSAGE", `Campo BAL inválido: ${field}`);
  }
  return value;
}

function base(value: unknown): { raw: Record<string, unknown>; requestId: string; nonce: string } {
  const raw = record(value);
  if (raw.protocol !== BAL_PROTOCOL) throw new BalError("INVALID_MESSAGE", "Protocolo BAL inválido");
  if (raw.version !== BAL_VERSION) {
    throw new BalError("UNSUPPORTED_VERSION", "Versión BAL no soportada");
  }
  return {
    raw,
    requestId: stringField(raw.requestId, "requestId"),
    nonce: stringField(raw.nonce, "nonce"),
  };
}

export function normalizeBalPermissions(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) {
    throw new BalError("INVALID_MESSAGE", "BAL requiere entre 1 y 64 permisos");
  }
  const normalized = [...new Set(input.map((permission) => permission.trim()))].sort();
  if (normalized.some((permission) => !PERMISSION.test(permission))) {
    throw new BalError("INVALID_MESSAGE", "La solicitud contiene permisos BAL inválidos");
  }
  return normalized;
}

export function parseBalReady(value: unknown): BalReadyMessage {
  const { raw, requestId, nonce } = base(value);
  if (raw.type !== "BAL_READY") throw new BalError("INVALID_MESSAGE", "Se esperaba BAL_READY");
  const clientPubkey = stringField(raw.clientPubkey, "clientPubkey", HEX64);
  const permissions = normalizeBalPermissions(
    Array.isArray(raw.requestedPermissions) ? raw.requestedPermissions as string[] : [],
  );
  return {
    protocol: BAL_PROTOCOL,
    version: BAL_VERSION,
    type: "BAL_READY",
    requestId,
    nonce,
    gameId: stringField(raw.gameId, "gameId", GAME_ID),
    clientPubkey,
    requestedPermissions: permissions,
  };
}

export function parseBalSession(value: unknown, now = Date.now()): BalSessionMessage {
  const { raw, requestId, nonce } = base(value);
  if (raw.type !== "BAL_SESSION") throw new BalError("INVALID_MESSAGE", "Se esperaba BAL_SESSION");
  if (typeof raw.bunkerUri !== "string" || !raw.bunkerUri.startsWith("bunker://")) {
    throw new BalError("INVALID_MESSAGE", "Bunker URI BAL inválida");
  }
  if (!Number.isSafeInteger(raw.expiresAt) || (raw.expiresAt as number) <= now) {
    throw new BalError("EXPIRED", "La sesión BAL expiró");
  }
  return {
    protocol: BAL_PROTOCOL,
    version: BAL_VERSION,
    type: "BAL_SESSION",
    requestId,
    nonce,
    bunkerUri: raw.bunkerUri,
    expiresAt: raw.expiresAt as number,
  };
}

export function parseBalError(value: unknown): BalErrorMessage {
  const { raw, requestId, nonce } = base(value);
  if (raw.type !== "BAL_ERROR") throw new BalError("INVALID_MESSAGE", "Se esperaba BAL_ERROR");
  const code = stringField(raw.code, "code", /^[A-Z_]{3,40}$/) as BalErrorCode;
  const message = typeof raw.message === "string" ? raw.message.slice(0, 240) : "BAL no disponible";
  return { protocol: BAL_PROTOCOL, version: BAL_VERSION, type: "BAL_ERROR", requestId, nonce, code, message };
}

export function parseBalLogout(value: unknown): BalLogoutMessage {
  const { raw, requestId, nonce } = base(value);
  if (raw.type !== "BAL_LOGOUT") throw new BalError("INVALID_MESSAGE", "Se esperaba BAL_LOGOUT");
  const allowed = new Set(["game_logout", "launcher_logout", "revoked", "expired"]);
  const reason = typeof raw.reason === "string" && allowed.has(raw.reason)
    ? raw.reason as BalLogoutMessage["reason"]
    : undefined;
  return { protocol: BAL_PROTOCOL, version: BAL_VERSION, type: "BAL_LOGOUT", requestId, nonce, ...(reason ? { reason } : {}) };
}

export function parseBalMessage(value: unknown, now = Date.now()): BalMessage {
  const raw = record(value);
  switch (raw.type) {
    case "BAL_READY": return parseBalReady(value);
    case "BAL_SESSION": return parseBalSession(value, now);
    case "BAL_ERROR": return parseBalError(value);
    case "BAL_LOGOUT": return parseBalLogout(value);
    default: throw new BalError("INVALID_MESSAGE", "Tipo de mensaje BAL desconocido");
  }
}

export type BalTransportEnvelope<Peer = unknown> = {
  data: unknown;
  origin: string;
  peer: Peer;
};

/** Transporte abstracto: el núcleo BAL no depende de Window ni del navegador. */
export interface BalTransport<Peer = unknown> {
  send(peer: Peer, targetOrigin: string, message: BalMessage): void | Promise<void>;
  subscribe(handler: (envelope: BalTransportEnvelope<Peer>) => void): () => void;
}

/** Puertos reservados para transportes futuros. */
export interface BalEnvironmentTransport<Peer = unknown> extends BalTransport<Peer> {}
export interface BalLocalIpcTransport<Peer = unknown> extends BalTransport<Peer> {}
export interface BalNostrEventTransport<Peer = unknown> extends BalTransport<Peer> {}
export interface BalDeepLinkTransport<Peer = unknown> extends BalTransport<Peer> {}
export interface BalConsoleTransport<Peer = unknown> extends BalTransport<Peer> {}

export type BalIdentitySource = "email" | "nsec" | "nip07";

export type BalConsentRequest = {
  gameId: string;
  gameName: string;
  origin: string;
  identityId: string;
  pubkey: string;
  identitySource: BalIdentitySource;
  permissions: string[];
};

export type BalConsentDecision = "once" | "remember" | "deny";

export type BalAuthorization = BalConsentRequest & {
  id: string;
  createdAt: number;
  expiresAt: number;
};

export interface BalAuthorizationStore {
  list(): Promise<BalAuthorization[]> | BalAuthorization[];
  save(authorization: BalAuthorization): Promise<void> | void;
  remove(id: string): Promise<void> | void;
}

export function balAuthorizationId(input: BalConsentRequest): string {
  const parts = [
    input.gameId,
    input.origin,
    input.identityId,
    input.pubkey,
    input.identitySource,
    ...normalizeBalPermissions(input.permissions),
  ];
  return parts.map((part) => encodeURIComponent(part)).join("|");
}

export function createBalAuthorization(
  input: BalConsentRequest,
  now = Date.now(),
  ttlMs = BAL_DEFAULT_AUTHORIZATION_TTL_MS,
): BalAuthorization {
  return { ...input, permissions: normalizeBalPermissions(input.permissions), id: balAuthorizationId(input), createdAt: now, expiresAt: now + ttlMs };
}

export function matchesBalAuthorization(
  authorization: BalAuthorization,
  request: BalConsentRequest,
  now = Date.now(),
): boolean {
  return authorization.expiresAt > now && authorization.id === balAuthorizationId(request);
}

export class MemoryBalAuthorizationStore implements BalAuthorizationStore {
  private readonly records = new Map<string, BalAuthorization>();
  list(): BalAuthorization[] { return [...this.records.values()]; }
  save(authorization: BalAuthorization): void { this.records.set(authorization.id, authorization); }
  remove(id: string): void { this.records.delete(id); }
}

export function balErrorMessage(
  input: Pick<BalMessageBase, "requestId" | "nonce">,
  code: BalErrorCode,
  message: string,
): BalErrorMessage {
  return {
    protocol: BAL_PROTOCOL,
    version: BAL_VERSION,
    type: "BAL_ERROR",
    requestId: input.requestId,
    nonce: input.nonce,
    code,
    message: message.slice(0, 240),
  };
}
