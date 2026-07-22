/**
 * Web Push crypto + store. The headline test is the RFC 8291 §5 vector: fixed
 * salt + sender keypair must reproduce the RFC's exact ciphertext, byte for byte
 * — that single equality pins ECDH, both HKDF stages, the record delimiter, and
 * the aes128gcm header layout all at once.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { PATHS } from "./config";
import {
  b64url,
  fromB64url,
  encryptPayload,
  vapidAuthHeader,
  getVapidPublicKey,
  saveSubscription,
  getSubscription,
  removeSubscription,
  sendWebPush,
  isValidDeviceId,
} from "./web-push";

beforeEach(() => {
  rmSync(`${PATHS.dir}/push-vapid.json`, { force: true });
  rmSync(`${PATHS.dir}/push-subscriptions.json`, { force: true });
});

// --- RFC 8291 §5 test vector (values verbatim from the RFC) ---

const VECTOR = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  expected:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** Import the vector's fixed application-server keypair as ECDH keys. */
async function vectorSenderKeys(): Promise<CryptoKeyPair> {
  const pub = fromB64url(VECTOR.asPublic); // 0x04 ‖ x(32) ‖ y(32)
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    d: VECTOR.asPrivate,
  };
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  delete jwk.d;
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  return { privateKey, publicKey };
}

test("encryptPayload reproduces the RFC 8291 §5 ciphertext exactly", async () => {
  const out = await encryptPayload(
    new TextEncoder().encode(VECTOR.plaintext),
    fromB64url(VECTOR.uaPublic),
    fromB64url(VECTOR.auth),
    { salt: fromB64url(VECTOR.salt), senderKeys: await vectorSenderKeys() },
  );
  expect(b64url(out)).toBe(VECTOR.expected);
});

test("encryptPayload without seams produces a decryptable-shaped body (header + unique salt)", async () => {
  const plaintext = new TextEncoder().encode("hi");
  const [a, b] = await Promise.all([
    encryptPayload(plaintext, fromB64url(VECTOR.uaPublic), fromB64url(VECTOR.auth)),
    encryptPayload(plaintext, fromB64url(VECTOR.uaPublic), fromB64url(VECTOR.auth)),
  ]);
  // header: salt(16) + rs(4) + idlen(1) + key(65); record: plaintext + delimiter + 16-byte tag
  expect(a.length).toBe(86 + plaintext.length + 1 + 16);
  expect(a[20]).toBe(65); // idlen
  expect(b64url(a.slice(0, 16))).not.toBe(b64url(b.slice(0, 16))); // fresh salt per push
});

// --- VAPID ---

test("vapidAuthHeader emits a verifiable ES256 JWT with aud/exp/sub", async () => {
  const header = await vapidAuthHeader("https://web.push.apple.com", "mailto:x@y.z", 1_700_000_000_000);
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  expect(m).not.toBeNull();
  const [h, c, s] = m![1]!.split(".");
  const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
  expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
  expect(claims.aud).toBe("https://web.push.apple.com");
  expect(claims.sub).toBe("mailto:x@y.z");
  expect(claims.exp).toBe(1_700_000_000 + 12 * 3600);
  // Signature verifies against the persisted public key
  const pub = await crypto.subtle.importKey(
    "raw",
    fromB64url(m![2]!) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pub,
    fromB64url(s!) as BufferSource,
    new TextEncoder().encode(`${h}.${c}`),
  );
  expect(ok).toBe(true);
});

test("VAPID keypair persists — same public key across loads", async () => {
  const first = await getVapidPublicKey();
  expect(await getVapidPublicKey()).toBe(first);
  expect(fromB64url(first).length).toBe(65);
});

// --- deviceId validation (ids land in file paths — must be traversal-proof) ---

test("isValidDeviceId accepts UUIDs, rejects traversal and junk", () => {
  expect(isValidDeviceId("2f1e9a4c-9c1b-4f6e-8a3d-1b2c3d4e5f6a")).toBe(true);
  expect(isValidDeviceId("../../etc/passwd")).toBe(false);
  expect(isValidDeviceId("a/b")).toBe(false);
  expect(isValidDeviceId("short")).toBe(false);
  expect(isValidDeviceId("")).toBe(false);
  expect(isValidDeviceId(null)).toBe(false);
  expect(isValidDeviceId(42)).toBe(false);
});

// --- Subscription store ---

const SUB = { endpoint: "https://web.push.apple.com/QOX", keys: { p256dh: VECTOR.uaPublic, auth: VECTOR.auth } };

test("subscription store round-trips per device and removes cleanly", () => {
  saveSubscription("dev-a", SUB);
  saveSubscription("dev-b", { ...SUB, endpoint: "https://web.push.apple.com/other" });
  expect(getSubscription("dev-a")?.endpoint).toBe(SUB.endpoint);
  expect(getSubscription("dev-b")?.endpoint).toBe("https://web.push.apple.com/other");
  removeSubscription("dev-a");
  expect(getSubscription("dev-a")).toBeNull();
  expect(getSubscription("dev-b")).not.toBeNull();
});

// --- sendWebPush prune behavior (fetch stubbed) ---

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number): { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls };
}

test("sendWebPush posts encrypted body with VAPID + aes128gcm headers", async () => {
  saveSubscription("dev-a", SUB);
  const { calls } = stubFetch(201);
  await sendWebPush("dev-a", { title: "Turn complete", body: "csm · Fix Auth", sessionId: "s1" });
  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe(SUB.endpoint);
  expect(calls[0]!.headers["Content-Encoding"]).toBe("aes128gcm");
  expect(calls[0]!.headers.TTL).toBe("86400");
  expect(calls[0]!.headers.Urgency).toBe("high");
  expect(calls[0]!.headers.Authorization).toStartWith("vapid t=");
  expect(getSubscription("dev-a")).not.toBeNull(); // 201 doesn't prune
});

for (const status of [401, 403, 404, 410]) {
  test(`sendWebPush prunes the subscription on ${status}`, async () => {
    saveSubscription("dev-a", SUB);
    stubFetch(status);
    await sendWebPush("dev-a", { title: "t", body: "b", sessionId: "s1" });
    expect(getSubscription("dev-a")).toBeNull();
  });
}

test("sendWebPush is a no-op without a subscription", async () => {
  const { calls } = stubFetch(201);
  await sendWebPush("ghost", { title: "t", body: "b", sessionId: "s1" });
  expect(calls.length).toBe(0);
});
