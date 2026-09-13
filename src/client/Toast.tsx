import { CircleAlert, CircleCheck, Info, X } from "lucide-react";

export type ToastTone = "info" | "success" | "error";
export type Notice = { message: string; tone: ToastTone };
export type Notify = (message: string, tone?: ToastTone) => void;

export function Toast({
  notice,
  dismiss,
}: {
  notice: Notice;
  dismiss: () => void;
}) {
  const Icon =
    notice.tone === "error"
      ? CircleAlert
      : notice.tone === "success"
        ? CircleCheck
        : Info;
  return (
    <div
      className={`toast ${notice.tone}`}
      role={notice.tone === "error" ? "alert" : "status"}
      aria-atomic="true"
    >
      <Icon size={18} aria-hidden="true" />
      <span>{notice.message}</span>
      <button aria-label="Dismiss notification" onClick={dismiss}>
        <X size={18} />
      </button>
    </div>
  );
}
