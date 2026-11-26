import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { getSessionHome } from "@/lib/portal/api";
import { useEffect, useState } from "react";
import { authEnabled, signIn } from "@/lib/auth/client";
import { confirmPortalPassword, requestPortalPassword, signInWithInvitation, signUpPortal } from "@/lib/auth/invited-sign-in";

export const Route = createFileRoute("/production/signin")({
  head: () => ({
    meta: [
      { title: "Sign in · Manage Tech Service User Portal" },
      { name: "description", content: "Create an account or sign in to the Manage Tech Service User Portal." },
    ],
  }),
  component: ProductionSignIn,
});

const font = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';

function WaveBand({ className, fill, duration, reverse, crest, edge }: { className: string; fill: string; duration: string; reverse?: boolean; crest: "high" | "low"; edge: "top" | "bottom" }) {
  const high = crest === "high";
  const d = edge === "bottom"
    ? high
      ? "M0,150 C180,70 360,230 720,150 C900,70 1080,230 1440,150 L1440,360 L0,360 Z"
      : "M0,210 C180,150 360,270 720,210 C900,150 1080,270 1440,210 L1440,360 L0,360 Z"
    : high
      ? "M0,170 C180,250 360,90 720,170 C900,250 1080,90 1440,170 L1440,0 L0,0 Z"
      : "M0,120 C180,180 360,60 720,120 C900,180 1080,60 1440,120 L1440,0 L0,0 Z";
  return (
    <div className={`pointer-events-none absolute inset-x-0 -z-10 overflow-hidden ${className}`}>
      <svg className={reverse ? "mts-wave-loop-rev" : "mts-wave-loop"} style={{ animationDuration: duration }} viewBox="0 0 1440 360" preserveAspectRatio="none" aria-hidden="true">
        <path fill={fill} d={d} />
      </svg>
    </div>
  );
}

function ProductionSignIn() {
  const { user, isPending } = useCurrentUserState();
  const home = useQuery({ queryKey: ["session-home", user?.id], queryFn: () => getSessionHome(), enabled: Boolean(user), retry: false });
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "forgot" | "reset">("sign-in");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (code && state) {
      const seen = `zd-code:${code}`;
      if (sessionStorage.getItem(seen)) return;
      sessionStorage.setItem(seen, "1");
      const next = `/api/zendesk/customer/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      window.location.replace(next);
      return;
    }
    const verified = params.get("verified");
    if (verified === "1") setNotice("Your email is verified. Sign in with your invitation password.");
    if (verified === "expired") setError("That verification link expired. Sign in if you already verified, or ask MTS for a new one.");
  }, []);

  useEffect(() => {
    if (!isPending && user && home.isSuccess) {
      window.location.replace(home.data.desk ? "/production/admin-portal" : "/production/user-portal");
    }
  }, [isPending, user, home.isSuccess, home.data]);

  function socialSignIn(providerId: "grok-google" | "grok-microsoft" | "zendesk") {
    setError("");
    setBusy(true);
    void signIn(providerId, {
      callbackURL: "/production/signin",
      errorCallbackURL: "/production/signin",
    }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Sign-in was cancelled.");
      setBusy(false);
    });
  }

  async function requestCode() {
    setError("");
    setNotice("");
    if (!email.includes("@")) {
      setError("Enter the email from your invitation.");
      return;
    }
    setBusy(true);
    try {
      await requestPortalPassword({ data: { email } });
      setNotice("A 6-digit code was sent to that email. Enter it on this page.");
      setMode("reset");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await confirmPortalPassword({ data: { email, code, password } });
      await signInWithInvitation({ data: { email, password } });
      window.location.replace("/production/signin");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the password.");
      setBusy(false);
    }
  }

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await signUpPortal({ data: { name, email, password } });
      window.location.replace("/production/signin");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The account could not be created.");
      setBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await signInWithInvitation({ data: { email, password } });
      window.location.replace("/production/signin");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign in.");
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh bg-[#f5f5f7] text-[#1d1d1f] lg:grid-cols-2" style={{ fontFamily: font }}>
      <section className="relative isolate flex min-h-[46vh] flex-col justify-between overflow-hidden px-8 py-10 text-white sm:px-14 sm:py-14 lg:min-h-dvh">
        <div className="absolute inset-0 -z-20 bg-[linear-gradient(155deg,#003970_0%,#04577c_36%,#127e86_74%,#1bb8b4_100%)]" />
        <div className="pointer-events-none absolute -left-24 -top-24 -z-10 h-72 w-72 rounded-full bg-[#19c2c6]/30 blur-3xl" />
        <WaveBand edge="top" className="top-0 h-[38%]" duration="28s" reverse fill="rgba(255,255,255,0.12)" crest="high" />
        <WaveBand edge="top" className="top-0 h-[26%]" duration="18s" fill="rgba(0,57,112,0.20)" crest="low" />
        <WaveBand edge="bottom" className="bottom-0 h-[42%]" duration="22s" fill="rgba(255,255,255,0.14)" crest="low" />
        <WaveBand edge="bottom" className="bottom-0 h-[30%]" duration="14s" reverse fill="rgba(255,255,255,0.22)" crest="high" />
        <WaveBand edge="bottom" className="bottom-0 h-[18%]" duration="32s" fill="rgba(0,57,112,0.28)" crest="low" />
        <Link to="/production/signin" className="relative text-sm font-medium tracking-tight text-white/80">
          Manage Tech Service
        </Link>
        <div className="relative py-16 lg:py-0">
          <h1 className="max-w-md text-5xl font-semibold tracking-[-0.03em] sm:text-6xl">Manage Tech Service</h1>
          <p className="mt-5 max-w-sm text-lg leading-8 text-white/75">Create an account, then manage tickets, orders, and support from this portal.</p>
        </div>
        <p className="relative text-sm text-white/70">New customers can create an account. Staff access is assigned after sign-up.</p>
        <style>{`
          .mts-wave-loop, .mts-wave-loop-rev {
            display: block;
            width: 200%;
            height: 100%;
            animation: mtsWaveLoop linear infinite;
          }
          .mts-wave-loop-rev { animation-direction: reverse; }
          @keyframes mtsWaveLoop {
            from { transform: translate3d(0, 0, 0); }
            to { transform: translate3d(-50%, 0, 0); }
          }
          @media (prefers-reduced-motion: reduce) {
            .mts-wave-loop, .mts-wave-loop-rev { animation: none; }
          }
        `}</style>
      </section>
      <section className="flex items-center justify-center px-6 py-16 sm:px-12">
        <div className="w-full max-w-sm">
          <h2 className="text-3xl font-semibold tracking-[-0.03em]">{mode === "sign-up" ? "Create account" : mode === "sign-in" ? "Sign in" : "Forgot password"}</h2>
          <p className="mt-3 text-[15px] leading-7 text-[#6e6e73]">
            {mode === "sign-up" ? "Use your name, email, and a password. You can sign in right after." : mode === "sign-in" ? "Sign in with your email. New here? Create an account first." : "We email a code if this address already has an account."}
          </p>
          {home.isError ? <p className="mt-4 text-sm text-[#8e1f0b]" role="alert">Your session is active, but the portal could not resolve your access. Check the Zendesk connection and try again.</p> : null}
          {authEnabled && (mode === "sign-in" || mode === "sign-up") ? (
            <div className="mt-8 grid gap-3">
              <button type="button" disabled={busy} onClick={() => socialSignIn("zendesk")} className="flex h-12 items-center justify-center rounded-full bg-[#003970] text-sm font-semibold text-white disabled:opacity-50">Continue with Zendesk</button>
              <button type="button" disabled={busy} onClick={() => socialSignIn("grok-google")} className="flex h-12 items-center justify-center gap-3 rounded-full border border-black/10 bg-white text-sm font-semibold disabled:opacity-50">
                <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.71v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.61z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.95 10.7A5.41 5.41 0 0 1 3.66 9c0-.59.1-1.16.29-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.03l2.99-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z"/></svg>
                Continue with Google
              </button>
              <button type="button" disabled={busy} onClick={() => socialSignIn("grok-microsoft")} className="flex h-12 items-center justify-center gap-3 rounded-full border border-black/10 bg-white text-sm font-semibold disabled:opacity-50">
                <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true"><path fill="#F25022" d="M1 1h7.5v7.5H1z"/><path fill="#7FBA00" d="M9.5 1H17v7.5H9.5z"/><path fill="#00A4EF" d="M1 9.5h7.5V17H1z"/><path fill="#FFB900" d="M9.5 9.5H17V17H9.5z"/></svg>
                Continue with Microsoft
              </button>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-xs uppercase tracking-[0.14em] text-[#6e6e73]">
                <span className="h-px bg-black/10" />
                or
                <span className="h-px bg-black/10" />
              </div>
            </div>
          ) : null}
          {authEnabled ? (
            <form className={`${mode === "sign-in" ? "mt-4" : "mt-8"} grid gap-4`} onSubmit={mode === "sign-up" ? createAccount : mode === "reset" ? savePassword : mode === "forgot" ? (event) => { event.preventDefault(); void requestCode(); } : submit}>
              {mode === "sign-up" ? (
                <label className="grid gap-2 text-sm font-medium">
                  Name
                  <input value={name} onChange={(event) => setName(event.target.value)} required autoComplete="name" placeholder="Your name" className="h-12 rounded-2xl border border-black/10 bg-white px-4 text-base font-normal outline-none" />
                </label>
              ) : null}
              <label className="grid gap-2 text-sm font-medium">
                Email
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" placeholder="you@company.com" className="h-12 rounded-2xl border border-black/10 bg-white px-4 text-base font-normal outline-none" />
              </label>
              {mode !== "forgot" ? (
                <label className="grid gap-2 text-sm font-medium">
                  <span className="flex items-center justify-between">
                    {mode === "reset" ? "New password" : "Password"}
                    <button type="button" onClick={() => setShowPassword((current) => !current)} className="text-xs font-semibold text-[#127e86]">{showPassword ? "Hide" : "Show"}</button>
                  </span>
                  <input type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} autoComplete={mode === "sign-in" ? "current-password" : "new-password"} placeholder="At least 8 characters" className="h-12 rounded-2xl border border-black/10 bg-white px-4 text-base font-normal outline-none" />
                </label>
              ) : null}
              {error ? <p className="text-sm text-[#8e1f0b]" role="alert">{error}</p> : null}
              {notice ? <p className="text-sm text-[#0c5132]" role="status">{notice}</p> : null}
              {mode === "reset" ? (
                <label className="grid gap-2 text-sm font-medium">
                  Verification code
                  <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} required pattern="[0-9]{6}" placeholder="6-digit code" className="h-12 rounded-2xl border border-black/10 bg-white px-4 text-base font-normal outline-none" />
                </label>
              ) : null}
              <button type="submit" disabled={busy} className="mt-2 h-12 rounded-full bg-[#1d1d1f] text-sm font-semibold text-white disabled:opacity-50">
                {busy ? "Please wait" : mode === "sign-up" ? "Create account" : mode === "reset" ? "Set password" : mode === "forgot" ? "Send code" : "Sign in"}
              </button>
              {mode === "sign-in" ? (
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => { setError(""); setNotice(""); setMode("sign-up"); }} className="text-sm font-semibold text-[#127e86]">
                    Create an account
                  </button>
                  <button type="button" onClick={() => { setError(""); setNotice(""); setMode("forgot"); }} className="text-sm font-semibold text-[#127e86]">
                    Forgot password?
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => { setError(""); setNotice(""); setCode(""); setMode("sign-in"); }} className="justify-self-start text-sm font-semibold text-[#127e86]">
                  Back to sign in
                </button>
              )}
            </form>
          ) : (
            <p className="mt-8 text-sm text-[#6e6e73]">Sign-in is disabled.</p>
          )}
        </div>
      </section>
    </main>
  );
}
