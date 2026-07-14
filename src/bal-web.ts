import {
  BalError,
  type BalAuthorization,
  type BalAuthorizationStore,
  type BalMessage,
  type BalTransport,
  type BalTransportEnvelope,
} from "./bal-core.js";

function validateTargetOrigin(origin: string): string {
  if (!origin || origin === "*" || origin === "null") {
    throw new BalError("TRANSPORT_ERROR", "BAL exige un targetOrigin explícito");
  }
  let parsed: URL;
  try { parsed = new URL(origin); } catch {
    throw new BalError("TRANSPORT_ERROR", "targetOrigin BAL inválido");
  }
  if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
    throw new BalError("TRANSPORT_ERROR", "targetOrigin BAL debe ser un origen HTTP(S)");
  }
  return origin;
}

/** Único transporte implementado en BAL v1. Nunca envía con targetOrigin="*". */
export class WebPostMessageTransport implements BalTransport<Window> {
  constructor(private readonly ownWindow: Window = window) {}

  send(peer: Window, targetOrigin: string, message: BalMessage): void {
    validateTargetOrigin(targetOrigin);
    if (!peer || typeof peer.postMessage !== "function") {
      throw new BalError("TRANSPORT_ERROR", "Ventana peer BAL inválida");
    }
    peer.postMessage(message, targetOrigin);
  }

  subscribe(handler: (envelope: BalTransportEnvelope<Window>) => void): () => void {
    const listener = (event: MessageEvent<unknown>) => {
      if (!event.source || typeof (event.source as Window).postMessage !== "function") return;
      handler({ data: event.data, origin: event.origin, peer: event.source as Window });
    };
    this.ownWindow.addEventListener("message", listener);
    return () => this.ownWindow.removeEventListener("message", listener);
  }
}

/** Persistencia web de consentimientos recordados. No almacena Bunker URIs. */
export class WebStorageBalAuthorizationStore implements BalAuthorizationStore {
  constructor(
    private readonly storage: Storage,
    private readonly key = "org.nostr.bal.authorizations.v1",
  ) {}

  list(): BalAuthorization[] {
    try {
      const parsed = JSON.parse(this.storage.getItem(this.key) ?? "[]") as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is BalAuthorization => {
        if (!item || typeof item !== "object") return false;
        const value = item as Partial<BalAuthorization>;
        return typeof value.id === "string" && typeof value.expiresAt === "number";
      });
    } catch { return []; }
  }

  save(authorization: BalAuthorization): void {
    const records = this.list().filter((item) => item.id !== authorization.id && item.expiresAt > Date.now());
    records.push(authorization);
    this.storage.setItem(this.key, JSON.stringify(records));
  }

  remove(id: string): void {
    this.storage.setItem(this.key, JSON.stringify(this.list().filter((item) => item.id !== id)));
  }
}
