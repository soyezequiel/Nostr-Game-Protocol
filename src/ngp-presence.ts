// PRESENCIA NIP-38 — ORQUESTACIÓN del lado juego (heartbeat, throttle, clears).
//
// El WIRE del evento (kind:30315, ancla `a`, `d`="general", NIP-40) vive en
// `ngp-core.ts`; acá vive el CICLO DE VIDA que todo juego repite y que Tetris y
// Ajedrez implementaron por separado hasta converger en este superset:
//
//  · Heartbeat que re-firma antes de que venza el TTL, SIN gate de visibilidad:
//    "jugando" = juego ABIERTO, no en primer plano (gatear por pestaña visible
//    se probó y estaba MAL: mirar la tienda te bajaba la presencia en ~1 min).
//    De fondo los navegadores estrangulan los timers a ~1 disparo/min; el TTL
//    default (180s) tolera hasta dos latidos estrangulados sin titilar.
//  · Throttle de firma: cada re-publicación es una FIRMA (con NIP-07/46 puede
//    ser un prompt al usuario) — no se re-firma antes de `minResignMs` salvo
//    que CAMBIE el mensaje, y los fallos del firmante no se reintentan en
//    caliente (cooldown) para no spamear prompts.
//  · Throttle PERSISTIDO (opcional, `storage`): si el último evento publicado
//    sigue fresco tras recargar la página, `start()` NO re-firma — es lo que
//    evita el popup de la extensión en cada reload.
//  · Clear PRE-FIRMADO para el cierre de pestaña: firmar en `pagehide` no llega
//    (la firma es async y el navegador mata la página antes), así que cada
//    publicación deja firmado su clear (`created_at`+1 para ganar el slot
//    replaceable) y `clearNow()` solo lo despacha sincrónicamente.
//  · Clear de logout (`stop()`): firma un clear fresco para que "Jugando X"
//    desaparezca ya, sin esperar el TTL, y olvida el estado persistido.
//
// Fiel a la filosofía del paquete, el I/O entra por parámetro: `publish` /
// `publishSync` son del juego (su pool, sus relays) y `storage` es cualquier
// cosa con forma de localStorage. Acá no hay relays, ni env, ni DOM.
import type { Event } from 'nostr-tools';
import type { NgpSigner } from './ngp.js';
import { buildPresenceTemplate, buildPresenceClearTemplate } from './ngp-core.js';

/** TTL default de la presencia (NIP-40). Es la RED DE SEGURIDAD si el clear del
 *  cierre no llegó a salir (crash): fantasma acotado a ~3 min. NO puede ser
 *  menor: ver la nota de visibilidad/estrangulamiento en el header. */
export const NGP_PRESENCE_DEFAULT_TTL_SEC = 180;
/** Cada cuánto revisa el heartbeat si toca re-firmar (ms). De fondo el
 *  navegador lo estira a ~60s; el TTL lo absorbe. */
export const NGP_PRESENCE_DEFAULT_HEARTBEAT_MS = 20_000;
/** Mínimo entre firmas (ms): no molestar al firmante más seguido, salvo cambio
 *  de mensaje. También es el cooldown tras un fallo de firma/publicación. */
export const NGP_PRESENCE_DEFAULT_MIN_RESIGN_MS = 40_000;

/** Subset estructural de `localStorage` (el paquete no depende del DOM). */
export interface NgpPresenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface NgpPresenceManagerOptions {
  signer: NgpSigner;
  /** Coordenada del juego (`30023:<firmante>:<slug>`) — ancla de la presencia. */
  gameCoord: string;
  /**
   * Publica el evento en los relays de escritura del juego. Que RESUELVA cuando
   * al menos un relay aceptó y RECHACE si ninguno (patrón
   * `Promise.any(pool.publish(relays, evt))`): el manager solo cuenta como
   * "publicado" (throttle, estado persistido) lo que resolvió.
   */
  publish: (event: Event) => Promise<unknown>;
  /**
   * Envío fire-and-forget para el cierre de pestaña (`clearNow`): debe encolar
   * el send sobre sockets YA abiertos sin await. Default: `publish` ignorando
   * el resultado (suele alcanzar si el pool mantiene los sockets).
   */
  publishSync?: (event: Event) => void;
  ttlSec?: number;
  heartbeatMs?: number;
  minResignMs?: number;
  /**
   * Throttle persistido entre recargas (pasá `localStorage`): si el último
   * evento publicado sigue fresco, `start()` no re-firma — sin esto, cada
   * reload de la página es un prompt de la extensión.
   */
  storage?: NgpPresenceStorage | null;
  /** Clave del estado persistido. Default: `"ngp.presence.v1"`. */
  storageKey?: string;
  /**
   * pubkey (hex) de la sesión: invalida el estado persistido de OTRA cuenta.
   * Pasá la pubkey ya conocida del login — no la re-pidas al firmante, que con
   * algunas extensiones es otro prompt.
   */
  pubkey?: string;
}

export interface NgpPresenceManager {
  /**
   * Anuncia `message` y arranca el heartbeat. Idempotente: si ya corre solo
   * actualiza el mensaje (re-firma únicamente si cambió). La primera firma
   * puede saltearse por el throttle persistido (mismo mensaje aún fresco).
   */
  start(message: string): void;
  /** Cambia el estado visible ("Jugando X" ↔ "En X"). Re-firma ya si cambió. */
  setMessage(message: string): void;
  /** true si el heartbeat está corriendo. */
  isRunning(): boolean;
  /**
   * Teardown con tiempo (logout / volver al home): corta el heartbeat, publica
   * un clear y OLVIDA el estado persistido (la próxima sesión re-anuncia).
   */
  stop(): Promise<void>;
  /**
   * Teardown SINCRÓNICO para `pagehide`: corta el heartbeat y despacha el clear
   * pre-firmado sin await. Conserva el estado persistido a propósito: en un
   * reload es lo que evita re-firmar al volver.
   */
  clearNow(): void;
}

type PersistedState = { pubkey?: string; message: string; at: number };

export function createPresenceManager(
  options: NgpPresenceManagerOptions,
): NgpPresenceManager {
  const {
    signer,
    gameCoord,
    publish,
    storage = null,
    pubkey,
  } = options;
  const ttlSec = options.ttlSec ?? NGP_PRESENCE_DEFAULT_TTL_SEC;
  const heartbeatMs = options.heartbeatMs ?? NGP_PRESENCE_DEFAULT_HEARTBEAT_MS;
  const minResignMs = options.minResignMs ?? NGP_PRESENCE_DEFAULT_MIN_RESIGN_MS;
  const storageKey = options.storageKey ?? 'ngp.presence.v1';
  const publishSync =
    options.publishSync ??
    ((event: Event) => {
      try {
        void publish(event).catch(() => {});
      } catch {
        // pool caído en pleno cierre: el TTL corto la baja solo
      }
    });

  let timer: ReturnType<typeof setInterval> | null = null;
  let currentMessage = '';
  /** Último mensaje que SALIÓ (publicado con éxito); '' = nada publicado. */
  let lastMessage = '';
  let lastPublishAt = 0;
  let lastFailAt = 0;
  let inFlight = false;
  let storageLoaded = false;
  let preparedClear: Event | null = null;

  function loadPersisted(): void {
    if (storageLoaded) return;
    storageLoaded = true;
    if (!storage) return;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return;
      const s = JSON.parse(raw) as PersistedState;
      if (typeof s.at !== 'number' || typeof s.message !== 'string') return;
      // Estado de otra cuenta: no sirve para throttlear ESTA sesión.
      if (pubkey && s.pubkey && s.pubkey !== pubkey) return;
      lastMessage = s.message;
      lastPublishAt = s.at;
    } catch {
      // storage bloqueado/corrupto: arrancamos de cero
    }
  }

  function savePersisted(): void {
    if (!storage) return;
    try {
      storage.setItem(
        storageKey,
        JSON.stringify({ pubkey, message: lastMessage, at: lastPublishAt }),
      );
    } catch {
      // sin persistencia: el próximo reload re-firma, nada más
    }
  }

  function forgetPersisted(): void {
    if (!storage) return;
    try {
      storage.removeItem(storageKey);
    } catch {
      // nada que limpiar
    }
  }

  /** Un latido: decide si toca firmar y publica. Best-effort: nunca lanza. */
  async function beat(): Promise<void> {
    if (inFlight || !currentMessage) return;
    loadPersisted();
    const now = Date.now();
    const changed = currentMessage !== lastMessage;
    const stale = now - lastPublishAt >= minResignMs;
    if (!changed && !stale) return;
    // Cooldown tras un fallo: un firmante que rechaza (o relays caídos) no se
    // reintenta en cada latido — sería un prompt cada `heartbeatMs`.
    if (lastFailAt && now - lastFailAt < minResignMs) return;
    inFlight = true;
    try {
      const evt = await signer.signEvent(
        buildPresenceTemplate({ gameCoord, message: currentMessage, ttlSec }),
      );
      await publish(evt);
      lastMessage = currentMessage;
      lastPublishAt = Date.now();
      lastFailAt = 0;
      savePersisted();
      // Pre-firmamos el clear correspondiente a ESTA presencia (`created_at`+1
      // para que gane el slot replaceable). Best-effort: si el firmante falla
      // queda el clear previo; peor caso, el TTL la baja solo.
      try {
        preparedClear = await signer.signEvent(
          buildPresenceClearTemplate({ createdAt: evt.created_at + 1, gameCoord }),
        );
      } catch {
        // sin clear pre-firmado: el cierre cae al TTL
      }
    } catch {
      lastFailAt = Date.now();
    } finally {
      inFlight = false;
    }
  }

  function stopHeartbeat(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** Olvida la sesión de presencia (logout): la próxima re-anuncia desde cero. */
  function reset(): void {
    stopHeartbeat();
    currentMessage = '';
    lastMessage = '';
    lastPublishAt = 0;
    lastFailAt = 0;
    storageLoaded = true; // no re-adoptar el estado persistido que vamos a borrar
    forgetPersisted();
  }

  return {
    start(message: string): void {
      currentMessage = message;
      if (timer !== null) {
        void beat(); // ya corría: solo re-firma si el mensaje cambió
        return;
      }
      void beat();
      timer = setInterval(() => void beat(), heartbeatMs);
    },

    setMessage(message: string): void {
      currentMessage = message;
      if (timer !== null) void beat();
    },

    isRunning(): boolean {
      return timer !== null;
    },

    async stop(): Promise<void> {
      const clear = preparedClear;
      preparedClear = null;
      reset();
      try {
        // Con tiempo (logout) preferimos un clear FRESCO — pisa seguro aunque el
        // pre-firmado haya quedado viejo; el pre-firmado es el fallback si el
        // firmante ya no responde.
        let evt: Event | null = null;
        try {
          evt = await signer.signEvent(buildPresenceClearTemplate({ gameCoord }));
        } catch {
          evt = clear;
        }
        if (evt) await publish(evt);
      } catch {
        // Best-effort: el TTL corto la baja solo.
      }
    },

    clearNow(): void {
      stopHeartbeat();
      // OJO: conserva el estado persistido — en un reload, ese estado es lo que
      // evita re-firmar (y re-promptar) al volver a abrir.
      const evt = preparedClear;
      if (!evt) return;
      preparedClear = null;
      publishSync(evt);
    },
  };
}
