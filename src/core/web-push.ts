/**
 * Web Push (RFC 8030/8291/8292) on Bun's WebCrypto — no dependency.
 *
 * Replaces the single ntfy topic: each portkey device registers its own push
 * subscription (keyed by deviceId), and the monitor pushes only to the device
 * that drove the turn. Payloads stay non-sensitive (label + category) even
 * though Web Push is end-to-end encrypted.
 *
 * State files (the monitor is a fresh process per tick — everything reads from
 * disk, nothing caches in memory):
 * - `~/.config/csm/push-vapid.json`      { publicKey: base64url raw P-256 point,
 *                                          privateJwk: JsonWebKey }
 * - `~/.config/csm/push-subscriptions.json`  { [deviceId]: PushSubscriptionJSON }
 *
 * The RFC 8291 §5 test vector fixes the salt and the "ephemeral" sender keypair,
 * so `encryptPayload` accepts both as an optional seam; production callers omit
 * them and get fresh randomness per push.
 */

import { readFileSync, mkdirSync } from "node:fs";
import { PATHS, writeAtomic } from "./config";
import type { StoredSubscription, PushPayload, EncryptSeams } from "../types";

const VAPID_PATH = `${PATHS.dir}/push-vapid.json`;
const SUBS_PATH = `${PATHS.dir}/push-subscriptions.json`;

/**
 * Per-device SSE liveness markers (`consumers/<deviceId>`): the bridge touches a
 * device's file on SSE connect + heartbeat and unlinks it on the goodbye beacon;
 * the monitor treats <40s-old as "this device is watching live — don't push".
 */
export const CONSUMERS_DIR = `${PATHS.dir}/consumers`;

/**
 * deviceIds come from clients and end up in file paths — accept only short
 * alphanumeric-hyphen ids (which covers crypto.randomUUID output, the shape
 * clients actually mint) so a crafted id can't traverse or collide.
 */
export function isValidDeviceId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

// ---------------------------------------------------------------------------
// Atomic JSON stores
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(PATHS.dir, { recursive: true });
  writeAtomic(path, JSON.stringify(value, null, 2));
}

// ---------------------------------------------------------------------------
// Subscription store
// ---------------------------------------------------------------------------

function readSubscriptions(): Record<string, StoredSubscription> {
  return readJson<Record<string, StoredSubscription>>(SUBS_PATH) ?? {};
}

export function saveSubscription(deviceId: string, sub: StoredSubscription): void {
  try {
    const subs = readSubscriptions();
    subs[deviceId] = sub;
    writeJson(SUBS_PATH, subs);
  } catch {
    // Non-fatal — the device just won't receive pushes until it resubscribes.
  }
}

export function getSubscription(deviceId: string): StoredSubscription | null {
  return readSubscriptions()[deviceId] ?? null;
}

export function removeSubscription(deviceId: string): void {
  try {
    const subs = readSubscriptions();
    if (!(deviceId in subs)) return;
    delete subs[deviceId];
    writeJson(SUBS_PATH, subs);
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// VAPID keypair (generated once, persisted; public key doubles as the client's
// applicationServerKey and the `k=` parameter of the Authorization header)
// ---------------------------------------------------------------------------

interface VapidFile {
  publicKey: string; // base64url, 65-byte uncompressed P-256 point
  privateJwk: JsonWebKey;
}

export async function getVapidPublicKey(): Promise<string> {
  return (await loadOrCreateVapid()).publicKey;
}

/**
 * Deliberately throws if generating or persisting the keypair fails: handing out
 * a key that won't survive the process would let clients subscribe against a key
 * the next monitor tick can't sign with. Callers own the failure (`sendWebPush`
 * swallows it; the `/push/vapid-key` route turns it into a 500).
 */
async function loadOrCreateVapid(): Promise<VapidFile> {
  const existing = readJson<VapidFile>(VAPID_PATH);
  if (existing?.publicKey && existing.privateJwk) return existing;
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair;
  const created: VapidFile = {
    publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  writeJson(VAPID_PATH, created);
  return created;
}

/** `Authorization: vapid t=<ES256 JWT>, k=<public key>` for the endpoint's origin. */
export async function vapidAuthHeader(
  endpointOrigin: string,
  contact: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const vapid = await loadOrCreateVapid();
  const key = await crypto.subtle.importKey(
    "jwk",
    vapid.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const enc = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signing = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({
    aud: endpointOrigin,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: contact,
  })}`;
  // WebCrypto ECDSA emits raw r||s (64 bytes) — exactly the JWS ES256 format.
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signing),
    ),
  );
  return `vapid t=${signing}.${b64url(sig)}, k=${vapid.publicKey}`;
}

// ---------------------------------------------------------------------------
// RFC 8291 payload encryption (aes128gcm, single record)
// ---------------------------------------------------------------------------

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bits: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
      key,
      bits,
    ),
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Encrypt `plaintext` for a subscription's (p256dh, auth) pair. Returns the full
 * aes128gcm body: header (salt ‖ rs ‖ idlen ‖ sender public key) ‖ ciphertext.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: Uint8Array,
  auth: Uint8Array,
  seams: EncryptSeams = {},
): Promise<Uint8Array> {
  const uaPublic = await crypto.subtle.importKey(
    "raw",
    p256dh as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sender =
    seams.senderKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", sender.publicKey));
  const salt = seams.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublic }, sender.privateKey, 256),
  );

  const text = (s: string) => new TextEncoder().encode(s);
  // RFC 8291: IKM = HKDF(salt=auth, ecdh_secret, "WebPush: info" ‖ 0x00 ‖ ua_public ‖ as_public)
  const ikm = await hkdf(
    ecdhSecret,
    auth,
    concat(text("WebPush: info\0"), p256dh, asPublicRaw),
    256,
  );
  // RFC 8188: CEK + nonce from the record salt
  const cek = await hkdf(ikm, salt, text("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, text("Content-Encoding: nonce\0"), 96);

  // Single (last) record: plaintext ‖ 0x02 delimiter
  const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      aesKey,
      concat(plaintext, new Uint8Array([0x02])) as BufferSource,
    ),
  );

  // Header: salt(16) ‖ rs=4096 (uint32 BE) ‖ idlen=65 ‖ as_public(65)
  const header = concat(
    salt,
    new Uint8Array([0, 0, 0x10, 0, asPublicRaw.length]),
    asPublicRaw,
  );
  return concat(header, ciphertext);
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/** VAPID `sub` contact — push services require one; it goes nowhere. */
const VAPID_CONTACT = "mailto:vibes.claudio3@throxy.us";

/**
 * POST an encrypted push to `deviceId`'s subscription. No subscription ⇒ no-op.
 * 401/403 (VAPID mismatch — e.g. a regenerated key) and 404/410 (subscription
 * gone) prune the entry so the device auto-resubscribes on next app open.
 * 3s abort so a slow push service can't stall the monitor tick; errors swallowed.
 */
export async function sendWebPush(deviceId: string, payload: PushPayload): Promise<void> {
  try {
    const sub = getSubscription(deviceId);
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return;

    const body = await encryptPayload(
      new TextEncoder().encode(JSON.stringify(payload)),
      fromB64url(sub.keys.p256dh),
      fromB64url(sub.keys.auth),
    );
    const auth = await vapidAuthHeader(new URL(sub.endpoint).origin, VAPID_CONTACT);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          TTL: "86400",
          Urgency: "high",
        },
        body: body as BodyInit,
        signal: controller.signal,
      });
      if ([401, 403, 404, 410].includes(res.status)) removeSubscription(deviceId);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Non-fatal — the device misses one push; nothing else depends on it.
  }
}
