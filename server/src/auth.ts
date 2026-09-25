import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";

/**
 * Student accounts: scrypt-hashed passwords in data/users.json and a signed,
 * HttpOnly session cookie. Each account is one student; every course belongs
 * to exactly one student.
 *
 *   ALEX_SECRET         cookie-signing secret (generated into data/.secret if unset)
 *   ALEX_ALLOW_SIGNUP   "false" closes registration (the first account can always be created)
 */

export interface User {
  id: string;
  username: string;
  passHash: string;
  createdAt: string;
}

export type AuthedRequest = Request & { user: User };

const COOKIE = "alex_session";
const MAX_AGE_S = 60 * 60 * 24 * 30;

export class Auth {
  private users: User[];
  private secret: Buffer;
  private attempts = new Map<string, { n: number; until: number }>();

  constructor(private root: string) {
    const file = join(root, "users.json");
    this.users = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    this.secret = Buffer.from(process.env.ALEX_SECRET || this.persistedSecret());
  }

  private persistedSecret() {
    const file = join(this.root, ".secret");
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    const s = randomBytes(32).toString("hex");
    writeFileSync(file, s, { mode: 0o600 });
    return s;
  }

  private save() {
    writeFileSync(join(this.root, "users.json"), JSON.stringify(this.users, null, 2), { mode: 0o600 });
  }

  get signupOpen() {
    return this.users.length === 0 || process.env.ALEX_ALLOW_SIGNUP !== "false";
  }

  signup(username: string, password: string): User {
    const name = username.trim().toLowerCase();
    if (!this.signupOpen) throw new HttpError(403, "Sign-up is closed on this server.");
    if (!/^[a-z0-9_.-]{3,32}$/.test(name)) throw new HttpError(400, "Username: 3–32 characters, letters, digits, . _ -");
    if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters.");
    if (this.users.some((u) => u.username === name)) throw new HttpError(409, "That username is taken.");
    const salt = randomBytes(16).toString("hex");
    const user: User = { id: `u_${randomUUID().slice(0, 12)}`, username: name, passHash: `${salt}:${scryptSync(password, salt, 64).toString("hex")}`, createdAt: new Date().toISOString() };
    this.users.push(user);
    this.save();
    return user;
  }

  login(username: string, password: string, ip: string): User {
    const key = `${ip}|${username.trim().toLowerCase()}`;
    const a = this.attempts.get(key);
    if (a && a.n >= 5 && a.until > Date.now()) throw new HttpError(429, "Too many attempts — try again in a few minutes.");
    const user = this.users.find((u) => u.username === username.trim().toLowerCase());
    // Always run scrypt (even for unknown users) so timing doesn't reveal which usernames exist.
    const [salt, hash] = (user?.passHash ?? `${"0".repeat(32)}:${"0".repeat(128)}`).split(":");
    const ok = timingSafeEqual(Buffer.from(hash, "hex"), scryptSync(password, salt, 64)) && !!user;
    if (!ok) {
      this.attempts.set(key, { n: (a?.n ?? 0) + 1, until: Date.now() + 5 * 60_000 });
      throw new HttpError(401, "Wrong username or password.");
    }
    this.attempts.delete(key);
    return user!;
  }

  // ---------------------------------------------------------------- cookies

  private sign(v: string) {
    return createHmac("sha256", this.secret).update(v).digest("base64url");
  }

  setCookie(req: Request, res: Response, user: User) {
    const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
    const value = `${user.id}.${exp}`;
    res.cookie(COOKIE, `${value}.${this.sign(value)}`, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: MAX_AGE_S * 1000, path: "/" });
  }

  clearCookie(res: Response) {
    res.clearCookie(COOKIE, { path: "/" });
  }

  userFrom(req: Request): User | undefined {
    const raw = parseCookies(req.headers.cookie)[COOKIE];
    if (!raw) return undefined;
    const [id, exp, sig] = raw.split(".");
    if (!id || !exp || !sig) return undefined;
    const expected = Buffer.from(this.sign(`${id}.${exp}`));
    const got = Buffer.from(sig);
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return undefined;
    if (Number(exp) * 1000 < Date.now()) return undefined;
    return this.users.find((u) => u.id === id);
  }

  /** Express middleware: 401 unless a valid session cookie is present. */
  require = (req: Request, res: Response, next: NextFunction) => {
    const user = this.userFrom(req);
    if (!user) return void res.status(401).json({ error: "Please sign in." });
    (req as AuthedRequest).user = user;
    next();
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
