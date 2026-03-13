import { useEffect } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { useSessionStore, type SessionState } from "@/features/session/store/useSessionStore";
import { clearSession } from "@/features/session/lib/sessionManager";

interface SessionRecoveryDialogProps {
  onRestore: (session: SessionState) => void;
  onDiscard: () => void;
}

function formatDate(timestamp: number): string {
  if (!timestamp) return "Unknown time";
  return new Date(timestamp * 1000).toLocaleString();
}

export function SessionRecoveryDialog({ onRestore, onDiscard }: SessionRecoveryDialogProps) {
  const { hasPendingSession, pendingSession } = useSessionStore();
  const dialogDisabled = localStorage.getItem("session-recovery-dialog-disabled") === "1";

  // Discard silently when popup is disabled in settings
  useEffect(() => {
    if (hasPendingSession && pendingSession && dialogDisabled) {
      clearSession();
      useSessionStore.getState().clearPendingSession();
    }
  }, [hasPendingSession, pendingSession, dialogDisabled]);

  const handleRestore = () => {
    if (pendingSession) {
      onRestore(pendingSession);
    }
    useSessionStore.getState().clearPendingSession();
  };

  const handleDiscard = async () => {
    await clearSession();
    onDiscard();
  };

  if (!hasPendingSession || !pendingSession || dialogDisabled) return null;

  const videoCount = pendingSession.videoFiles?.length ?? 0;
  const savedAt = formatDate(pendingSession.timestamp);

  return (
    <AlertDialog open={hasPendingSession}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore Previous Session?</AlertDialogTitle>
          <AlertDialogDescription>
            A previous session was found from <strong>{savedAt}</strong> with{" "}
            <strong>{videoCount}</strong> video{videoCount !== 1 ? "s" : ""} loaded.
            Would you like to restore it?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleDiscard}>Discard</AlertDialogCancel>
          <AlertDialogAction onClick={handleRestore}>Restore Session</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
