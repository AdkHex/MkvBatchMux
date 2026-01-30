import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CODE_TO_LABEL, LANGUAGE_ITEMS } from "@/data/languages-iso6393";

interface LanguageSelectProps {
  value?: string;
  onChange: (code: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  popoverClassName?: string;
}

const MAX_RESULTS = 200;

export function LanguageSelect({
  value,
  onChange,
  placeholder = "Select language",
  disabled,
  className,
  popoverClassName,
}: LanguageSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const handle = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [open]);

  const label = value ? CODE_TO_LABEL[value] ?? value : "";
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return LANGUAGE_ITEMS;
    return LANGUAGE_ITEMS.filter((item) => {
      return item.label.toLowerCase().includes(q) || item.value.toLowerCase().includes(q);
    });
  }, [query]);
  const limited = filtered.slice(0, MAX_RESULTS);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            "fluent-input justify-between gap-2 text-sm",
            !value && "text-muted-foreground",
            className,
          )}
          disabled={disabled}
          aria-expanded={open}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
              event.preventDefault();
              setOpen(true);
              setQuery(event.key);
              return;
            }
            if (event.key === "Backspace") {
              event.preventDefault();
              setOpen(true);
              setQuery("");
            }
          }}
        >
          <span className="truncate">
            {value ? label : placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn(
          "p-0 w-[320px] rounded-lg border border-panel-border/60 bg-popover/95 shadow-xl overflow-hidden",
          popoverClassName,
        )}
        align="start"
      >
        <Command
          className={cn(
            "rounded-none bg-transparent",
            "[&_[cmdk-input-wrapper]]:border-b-0 [&_[cmdk-input-wrapper]]:px-2 [&_[cmdk-input-wrapper]]:py-2",
            "[&_[cmdk-input-wrapper]]:bg-transparent",
            "[&_[cmdk-input-wrapper]]:border-t-0",
            "[&_[cmdk-item]]:px-3 [&_[cmdk-item]]:py-2.5 [&_[cmdk-item]]:rounded-md",
            "[&_[cmdk-item][data-selected=true]]:bg-accent/60 [&_[cmdk-item][data-selected=true]]:text-foreground",
          )}
        >
          <CommandInput
            ref={inputRef}
            placeholder="Search language or code..."
            value={query}
            onValueChange={setQuery}
            className="h-9 px-2 rounded-md bg-input/60 border border-panel-border/50 focus-visible:ring-1 focus-visible:ring-primary/60"
          />
          <CommandList className="max-h-[280px] px-1 pb-2">
            <CommandEmpty>No language found.</CommandEmpty>
            <CommandGroup>
              {limited.map((item) => {
                const isSelected = value === item.value;
                return (
                  <CommandItem
                    key={item.value}
                    value={`${item.label} ${item.value}`}
                    onSelect={() => {
                      onChange(item.value);
                      setOpen(false);
                    }}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span className="truncate">{item.label}</span>
                      <span className="text-xs text-muted-foreground ml-2">• {item.value}</span>
                    </div>
                    <Check className={cn("ml-2 h-4 w-4", isSelected ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
