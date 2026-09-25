import { useState } from "react";
import { api, type Me, type Status } from "../api";

/** Sign in / create a student account. */
export function Login({ status, onDone }: { status?: Status; onDone: (me: Me) => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const signupOpen = status?.signupOpen ?? true;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      onDone(await (mode === "login" ? api.login(username, password) : api.signup(username, password)));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-copy">
        <h1>Your personal university.</h1>
        <p className="lede">
          Alex finds exactly where your knowledge ends and teaches you from there, one step beyond what you can do alone, with a Librarian, an Advisor, a Tutor and an independent examiner working for you.
        </p>
      </div>
      <form className="card login-form" onSubmit={submit}>
        <h2>{mode === "login" ? "Sign in" : "Create your student account"}</h2>
        <label>
          Username
          <input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
        </label>
        <label>
          Password
          <input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={mode === "signup" ? 8 : undefined} />
        </label>
        {mode === "signup" && <p className="muted small">At least 8 characters. Usernames: letters, digits, . _ -</p>}
        {err && <p className="error">{err}</p>}
        <button className="primary" disabled={busy}>{busy ? "…" : mode === "login" ? "Sign in" : "Create account"}</button>
        {signupOpen ? (
          <p className="muted small switch">
            {mode === "login" ? "New here? " : "Already enrolled? "}
            <a href="#" onClick={(e) => (e.preventDefault(), setMode(mode === "login" ? "signup" : "login"), setErr(""))}>
              {mode === "login" ? "Create an account" : "Sign in"}
            </a>
          </p>
        ) : (
          <p className="muted small switch">Registration is closed on this server.</p>
        )}
      </form>
    </div>
  );
}
