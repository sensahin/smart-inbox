import { Mail, Trash2 } from "lucide-react";
import { ActionMenu } from "./ActionMenu";

export function ConversationMenu({
  disabled,
  onAction,
}: {
  disabled: boolean;
  onAction: (action: "unread" | "trash") => void;
}) {
  return (
    <ActionMenu
      label="Conversation actions"
      disabled={disabled}
      items={[
        {
          label: "Mark unread",
          icon: <Mail size={16} />,
          onSelect: () => onAction("unread"),
        },
        {
          label: "Trash",
          icon: <Trash2 size={16} />,
          danger: true,
          onSelect: () => onAction("trash"),
        },
      ]}
    />
  );
}
