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

test("open mode (default): each browser gets its own anonymous student, no login", () => {
  delete process.env.ALEX_REQUIRE_LOGIN;
  const auth = new Auth(mkdtempSync(join(tmpdir(), "alex-open-")));
  assert.equal(auth.loginRequired, false);
  const jar: Record<string, string> = {};
  const res = { cookie: (n: string, v: string) => void (jar[n] = v) } as any;
  const a = auth.current({ headers: {}, secure: true } as any, res)!;
  assert.match(a.id, /^g_[a-f0-9]{32}$/);
  assert.ok(jar.alex_student, "guest cookie issued");
  const again = auth.current({ headers: { cookie: `alex_student=${jar.alex_student}` } } as any, res)!;
  assert.equal(again.id, a.id, "same browser → same student");
  const other = auth.current({ headers: {} } as any, { cookie: () => {} } as any)!;
  assert.notEqual(other.id, a.id, "another browser → another student");
  const forged = auth.current({ headers: { cookie: "alex_student=../../etc" } } as any, { cookie: () => {} } as any)!;
  assert.match(forged.id, /^g_[a-f0-9]{32}$/, "malformed ids are replaced, never used as paths");
});
