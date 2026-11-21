import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

const source = readFileSync(new URL("../js/google-login.js", import.meta.url), "utf8")
  .replaceAll("export async function", "async function");
const key = "genesense-app-login";
const verifier = "a".repeat(64);
const code = "synthetic-one-time-code".padEnd(43, "x");

function app({ fetcher, expires = Date.now() + 300000, native = true } = {}) {
  let url = new URL("https://genesense-five.vercel.app/");
  const storage = new Map([[key, JSON.stringify({ verifier, expires })]]);
  const calls = [], assigned = [], messages = [];
  let reloads = 0;
  const location = {
    get href() { return url.href; }, get hash() { return url.hash; },
    get pathname() { return url.pathname; }, get search() { return url.search; },
    reload() { reloads++; }, assign(target) { assigned.push(target); },
  };
  const api = runInNewContext(source + "\n({loginWithGoogle,resumeGoogleLogin})", {
    location, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    crypto: webcrypto, TextEncoder, navigator: { userAgent: native ? "GeneSenseAndroid/0.4.3" : "Browser" },
    document: { documentElement: { classList: { contains: () => false } } },
    localStorage: { getItem: name => storage.get(name), setItem: (name, value) => storage.set(name, value), removeItem: name => storage.delete(name) },
    window: { history: { replaceState: (_a, _b, target) => { url = new URL(target, url); } } },
    fetch: async (path, options) => {
      calls.push({ path, ...options, body: JSON.parse(options.body) });
      return fetcher ? fetcher(path, options) : { ok: true, json: async () => ({ status: "authenticated" }) };
    },
  });
  return { ...api, calls, assigned, storage, messages, show: message => messages.push(message),
    back: () => { url = new URL("https://genesense-five.vercel.app/?review=auth&app_return=123#app-login?code=" + code); },
    get url() { return url; }, get reloads() { return reloads; } };
}

test("ordinary navigation never redeems an app code", async () => {
  const page = app();
  assert.equal(await page.resumeGoogleLogin(page.show), false);
  assert.equal(page.calls.length, 0);
});

test("a return to an already-running page redeems in its own cookie jar and reloads signed in", async () => {
  const page = app();
  await page.resumeGoogleLogin(page.show); // the page was already booted before Chrome opens
  page.back();
  assert.equal(await page.resumeGoogleLogin(page.show), true);
  assert.equal(page.calls[0].path, "/api/auth/mobile/redeem");
  assert.equal(page.calls[0].credentials, "same-origin");
  assert.equal(page.calls[0].body.verifier, verifier);
  assert.equal(page.calls[0].body.code, code);
  assert.equal(page.reloads, 1);
  assert.equal(page.url.hash, "");
  assert.equal(page.url.search, "?review=auth");
  assert.equal(page.storage.has(key), false);
});

test("a cold app return restores the saved verifier", async () => {
  const page = app();
  page.back();
  await page.resumeGoogleLogin(page.show);
  assert.equal(page.reloads, 1);
  assert.equal(page.calls[0].body.verifier, verifier);
});

test("expired attempts cannot create an app session", async () => {
  const page = app({ expires: Date.now() - 1000 });
  page.back();
  await page.resumeGoogleLogin(page.show);
  assert.equal(page.calls.length, 0);
  assert.equal(page.reloads, 0);
  assert.equal(page.storage.has(key), false);
  assert.match(page.messages.at(-1), /hết hạn/);
});

test("simultaneous boot and return events redeem a code once", async () => {
  let respond;
  const waiting = new Promise(resolve => { respond = resolve; });
  const page = app({ fetcher: async () => { await waiting; return { ok: true, json: async () => ({}) }; } });
  page.back();
  const first = page.resumeGoogleLogin(page.show);
  await page.resumeGoogleLogin(page.show);
  respond();
  await first;
  assert.equal(page.calls.length, 1);
  assert.equal(page.reloads, 1);
});

test("a temporary network failure does not discard proof before redemption succeeds", async () => {
  let failures = 1;
  const page = app({ fetcher: async () => {
    if (failures--) throw new Error("Synthetic offline transport");
    return { ok: true, json: async () => ({}) };
  } });
  page.back();
  await page.resumeGoogleLogin(page.show);
  assert.equal(page.storage.has(key), true);
  assert.equal(page.reloads, 0);
  page.back();
  await page.resumeGoogleLogin(page.show);
  assert.equal(page.reloads, 1);
  assert.equal(page.storage.has(key), false);
});

test("repeated taps cannot overwrite the in-flight app login proof", async () => {
  let respond;
  const waiting = new Promise(resolve => { respond = resolve; });
  const page = app({ fetcher: async () => {
    await waiting;
    return { ok: true, json: async () => ({ url: "https://genesense-five.vercel.app/api/auth/google?mobile=synthetic" }) };
  } });
  const first = page.loginWithGoogle(page.show);
  await page.loginWithGoogle(page.show);
  respond();
  await first;
  assert.equal(page.calls.length, 1);
  assert.equal(page.assigned.length, 1);
  assert.match(page.calls[0].body.challenge, /^[a-f0-9]{64}$/);
  assert.match(JSON.parse(page.storage.get(key)).verifier, /^[a-f0-9]{64}$/);
});

test("the normal website still uses its web login flow", async () => {
  const page = app({ native: false });
  await page.loginWithGoogle(page.show);
  assert.equal(page.assigned[0], "/api/auth/google");
  assert.equal(page.calls.length, 0);
});
