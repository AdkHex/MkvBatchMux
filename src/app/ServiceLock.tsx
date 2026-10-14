/** The remote lock's screen (docs/REMOTE-STATUS.md): "Work is in progress",
 *  "Update required", the access password, or "Connect to the internet once".
 *  It covers the whole window and cannot be dismissed; the window underneath
 *  is inert. The Rust core refuses the work itself, so this is only what the
 *  user sees, never the lock. */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import {
  checkServiceStatus,
  listenServiceLock,
  serviceLock,
  unlockAccess,
  type ServiceLock,
} from "@/shared/lib/backend";
import { AppIcon, CaptionButtons, OS } from "@/ui/frame";
import { Btn, Ring } from "@/ui/kit";

let lockedNow = false;

/** Whether the lock screen is up, for handlers outside React (menus, drops). */
export function isServiceLocked() {
  return lockedNow;
}

/** The lock as the backend has it: follow its event, and read it once the
 *  listener is in place, so a change between the two cannot be missed. An
 *  event that arrives first is newer than the read, which then gives way. */
function useServiceLock(): [ServiceLock | null, (lock: ServiceLock) => void] {
  const [lock, setLock] = useState<ServiceLock | null>(null);
  useEffect(() => {
    let alive = true;
    let heard = false;
    const unlisten = listenServiceLock((value) => {
      heard = true;
      setLock(value);
    });
    void unlisten
      .then(() => serviceLock())
      .then((value) => alive && !heard && setLock(value))
      .catch(() => undefined);
    return () => {
      alive = false;
      void unlisten.then((off) => off()).catch(() => undefined);
    };
  }, []);
  // Set after commit, not during render, so a discarded render can't leave a stale flag.
  useEffect(() => {
    lockedNow = !!lock?.locked;
  }, [lock]);
  return [lock, setLock];
}

/** Keep the window underneath out of reach: inert, and its shortcuts quiet. */
function useInertWindow(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const win = document.querySelector<HTMLElement>(".win");
    if (win) win.inert = true;
    // Only focus left in the window underneath: the password field has
    // already taken it by now.
    const focused = document.activeElement as HTMLElement | null;
    if (focused && !focused.closest(".lock")) focused.blur();
    const swallow = (event: KeyboardEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.(".lock")) event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", swallow, true);
    return () => {
      if (win) win.inert = false;
      window.removeEventListener("keydown", swallow, true);
    };
  }, [active]);
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const openLink = (url: string) => void import("@tauri-apps/api/shell").then(({ open }) => open(url)).catch(() => undefined);

/** At least long enough to see that something happened. */
async function atLeast<T>(ms: number, work: Promise<T>): Promise<T> {
  const [value] = await Promise.all([work, new Promise((resolve) => setTimeout(resolve, ms))]);
  return value;
}

function PasswordForm({ onUnlocked }: { onUnlocked: (lock: ServiceLock) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || checking) return;
    setChecking(true);
    setError(null);
    try {
      // The same text whatever keyboard or OS typed it.
      onUnlocked(await unlockAccess(password.normalize("NFC")));
    } catch (failure) {
      setError(String(failure));
      setPassword("");
      setTimeout(() => field.current?.focus(), 0);
    } finally {
      setChecking(false);
    }
  };

  return (
    <form className="lock-form" onSubmit={(event) => void submit(event)}>
      <label className="tbox lock-field">
        <input
          ref={field}
          type="password"
          aria-label="Access password"
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
          value={password}
          disabled={checking}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <div className="lock-error" role="alert">{error}</div>
      <Btn accent type="submit" disabled={!password || checking}>
        {checking ? <><Ring size={14} /> Checking…</> : "Unlock"}
      </Btn>
    </form>
  );
}

export function ServiceLockScreen() {
  const [lock, setLock] = useServiceLock();
  const [checking, setChecking] = useState(false);
  const locked = !!lock?.locked;
  useInertWindow(locked);
  if (!lock || !locked) return null;

  const checkAgain = async () => {
    setChecking(true);
    try {
      setLock(await atLeast(600, checkServiceStatus()));
    } catch {
      // The last known state stays.
    } finally {
      setChecking(false);
    }
  };

  const checkButton = (label: string, accent = false) => (
    <Btn accent={accent} onClick={() => void checkAgain()} disabled={checking}>
      {checking ? <><Ring size={14} /> Checking…</> : label}
    </Btn>
  );

  let title: string;
  let body: ReactNode;
  switch (lock.reason) {
    case "access":
      title = "Enter the access password";
      body = (
        <>
          <p className="lock-text">This app is strictly Prohibited to be used by others, if you are the trusted one enter the password</p>
          <PasswordForm onUnlocked={setLock} />
        </>
      );
      break;
    case "connect":
      title = "Connect to the internet once";
      body = (
        <>
          <p className="lock-text">MKVBatchMux checks its access the first time it opens. Connect to the internet, then try again.</p>
          {lock.lastError && <p className="lock-meta">{lock.lastError}</p>}
          <div className="lock-actions">{checkButton("Try again", true)}</div>
        </>
      );
      break;
    case "update":
      title = "Update required";
      body = (
        <>
          <p className="lock-text">{lock.message ?? "This version of MKVBatchMux is no longer supported. Please install the new version."}</p>
          <p className="lock-note">Your work is paused and will continue when MKVBatchMux is back.</p>
          <div className="lock-actions">
            {lock.updateUrl && <Btn accent onClick={() => openLink(lock.updateUrl!)}>Download the new version</Btn>}
            {checkButton("Check again")}
          </div>
          {lock.minVersion && <p className="lock-meta">Version {lock.appVersion} · required {lock.minVersion}</p>}
        </>
      );
      break;
    default:
      title = lock.title ?? "Work is in progress";
      body = (
        <>
          {lock.message && <p className="lock-text">{lock.message}</p>}
          <p className="lock-note">Your work is paused and will continue when MKVBatchMux is back.</p>
          <div className="lock-actions">{checkButton("Check again")}</div>
          {lock.checkedAt != null && <p className="lock-meta">Last checked at {clock(lock.checkedAt)}</p>}
        </>
      );
  }

  return createPortal(
    <div className="lock" role="alertdialog" aria-modal="true" aria-labelledby="lock-title">
      {/* The screen covers the title bar: keep the window movable, and on
          Windows (no native frame) its minimize, maximize and close. */}
      <div className="lock-bar" data-tauri-drag-region>
        {OS === "windows" && <CaptionButtons />}
      </div>
      <div className="lock-card">
        <AppIcon size={48} />
        <h1 id="lock-title" className="lock-title">{title}</h1>
        {body}
      </div>
    </div>,
    document.body,
  );
}
