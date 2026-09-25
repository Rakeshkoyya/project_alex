import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../src/auth.js";
import { selectedProvider } from "@alex/harness";

test("accounts: signup, login, signed cookies, lockout", () => {
  process.env.ALEX_SECRET = "test-secret";
  const auth = new Auth(mkdtempSync(join(tmpdir(), "alex-auth-")));
  const u = auth.signup("Rakesh", "supersecret1");
  assert.equal(u.username, "rakesh");
  assert.throws(() => auth.signup("rakesh", "anotherpass"), /taken/);
  assert.throws(() => auth.signup("x", "supersecret1"), /Username/);
  assert.throws(() => auth.signup("newbie", "short"), /8 characters/);
  assert.equal(auth.login("RAKESH", "supersecret1", "1.1.1.1").id, u.id);
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login("rakesh", "wrong", "2.2.2.2"), /Wrong/);
  assert.throws(() => auth.login("rakesh", "supersecret1", "2.2.2.2"), /Too many/);

  let cookie = "";
  const res = { cookie: (_n: string, v: string) => void (cookie = v) } as any;
  auth.setCookie({ secure: true } as any, res, u);
  const req = (c: string) => ({ headers: { cookie: `alex_session=${c}` } }) as any;
  assert.equal(auth.userFrom(req(cookie))?.id, u.id);
  assert.equal(auth.userFrom(req(cookie.replace(/.$/, (ch) => (ch === "A" ? "B" : "A")))), undefined, "tampered signature");
  const [id, , sig] = cookie.split(".");
  assert.equal(auth.userFrom(req(`${id}.1.${sig}`)), undefined, "expired / altered expiry");
});

test("provider selection: OpenRouter key wins, explicit override respected", () => {
  const saved = { ...process.env };
  delete process.env.ALEX_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  assert.equal(selectedProvider(), "demo");
  process.env.ANTHROPIC_API_KEY = "a";
  process.env.OPENROUTER_API_KEY = "o";
  assert.equal(selectedProvider(), "openrouter");
  process.env.ALEX_PROVIDER = "anthropic";
  assert.equal(selectedProvider(), "anthropic");
  process.env.ALEX_PROVIDER = "bogus";
  assert.throws(() => selectedProvider(), /ALEX_PROVIDER/);
  process.env = saved;
});
