/**
 * Session Manager - Frontend orchestration for session save/load/clear.
 * Wraps the Tauri backend session commands with debouncing and state integration.
 */
import { invoke } from "@tauri-apps/api/tauri";
import { useSessionStore, type SessionState } from "@/features/session/store/useSessionStore";

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 5000;
type SessionStateInput = SessionState | (() => SessionState);

/**
 * Schedule a debounced session save. Resets the timer on each call.
 * The save fires 5 seconds after the last state change.
 */
export function scheduleSave(state: SessionStateInput): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    const resolvedState = typeof state === "function" ? state() : state;
    void performSave(resolvedState);
    debounceTimer = null;
  }, DEBOUNCE_MS);
}

/** Cancel any pending debounced save. */
export function cancelScheduledSave(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/** Force an immediate save, bypassing the debounce timer. */
export async function forceSave(state: SessionState): Promise<void> {
  cancelScheduledSave();
  await performSave(state);
}

async function performSave(state: SessionState): Promise<void> {
  const store = useSessionStore.getState();
  store.setIsSaving(true);
  try {
    await invoke("save_session", { state });
    store.setLastSavedAt(Date.now());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.setLastSaveError(message);
  } finally {
    store.setIsSaving(false);
  }
}

/**
 * Check for an existing session on disk.
 * If found, stores it in useSessionStore so the recovery dialog can show.
 */
export async function checkForPendingSession(): Promise<boolean> {
  try {
    const session = await invoke<SessionState | null>("load_session");
    if (session) {
      useSessionStore.getState().setPendingSession(session);
      return true;
    }
  } catch {
    // Corrupt session was cleared server-side — proceed normally
  }
  return false;
}

/** Clear the session from disk. */
export async function clearSession(): Promise<void> {
  cancelScheduledSave();
  try {
    await invoke("clear_session");
  } catch {
    // Best-effort
  }
  useSessionStore.getState().clearPendingSession();
}
