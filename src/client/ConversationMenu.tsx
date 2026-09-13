import { useEffect, useRef, useState } from "react";
import { Mail, MoreVertical, Trash2 } from "lucide-react";

export function ConversationMenu({
  disabled,
  onAction,
}: {
  disabled: boolean;
  onAction: (action: "unread" | "trash") => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const initialItem = useRef(0);
  useEffect(() => {
    if (!open) return;
    const items =
      root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[initialItem.current]?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const dismiss = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className="conversation-menu"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        className="icon-button"
        aria-label="Conversation actions"
        title="Conversation actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "conversation-actions-menu" : undefined}
        disabled={disabled}
        onClick={() => {
          initialItem.current = 0;
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            initialItem.current = event.key === "ArrowUp" ? 1 : 0;
            setOpen(true);
          }
        }}
      >
        <MoreVertical size={19} />
      </button>
      {open && (
        <div
          id="conversation-actions-menu"
          className="conversation-menu-items"
          role="menu"
          aria-label="Conversation actions"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              dismiss();
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="menuitem"]',
              ),
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                    items.length;
            items[next]?.focus();
          }}
        >
          <button
            role="menuitem"
            onClick={() => {
              dismiss();
              onAction("unread");
            }}
          >
            <Mail size={16} /> Mark unread
          </button>
          <button
            role="menuitem"
            className="trash-action"
            onClick={() => {
              dismiss();
              onAction("trash");
            }}
          >
            <Trash2 size={16} /> Trash
          </button>
        </div>
      )}
    </div>
  );
}
