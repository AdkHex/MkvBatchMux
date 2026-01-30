import { Button } from "@/components/ui/button";
import { BaseModal } from "@/components/shared/BaseModal";
import { shortcuts } from "@/hooks/useKeyboardShortcuts";
import { Keyboard } from "lucide-react";

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsDialog({ open, onOpenChange }: KeyboardShortcutsDialogProps) {
  return (
    <BaseModal
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard Shortcuts"
      subtitle="List of available keyboard shortcuts."
      icon={<Keyboard className="w-5 h-5 text-primary" />}
      className="max-w-md"
      footerRight={
        <Button variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      <div className="space-y-3">
        {shortcuts.map((shortcut, index) => (
          <div
            key={index}
            className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/50"
          >
            <span className="text-sm text-foreground">{shortcut.description}</span>
            <div className="flex items-center gap-1">
              {shortcut.keys.map((key, keyIndex) => (
                <span key={keyIndex}>
                  <kbd className="px-2 py-1 text-xs font-mono font-semibold bg-background border border-border rounded shadow-sm">
                    {key}
                  </kbd>
                  {keyIndex < shortcut.keys.length - 1 && (
                    <span className="mx-1 text-muted-foreground">+</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-4 text-center">
        Press <kbd className="px-1.5 py-0.5 text-xs font-mono bg-background border border-border rounded">?</kbd> anytime to show this dialog
      </p>
    </BaseModal>
  );
}
