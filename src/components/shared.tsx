"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useId,
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  RefreshCw,
  AlertCircle,
  LoaderCircle,
  X,
} from "lucide-react";
import { cn } from "@/lib/ui";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch("/api/" + url, {
    ...options,
    headers: { ...options?.headers },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      data.code ?? "ERROR",
      data.message ?? "Не удалось выполнить запрос",
      response.status,
    );
  return data as T;
}
export function command<T>(
  url: string,
  data: unknown,
  method = "POST",
  key?: string,
) {
  return api<T>(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key ?? crypto.randomUUID(),
    },
    body: JSON.stringify(data),
  });
}
export function useResource<T>(url: string, interval = 0) {
  const [result, setResult] = useState<{ url: string; data: T } | null>(null),
    [error, setError] = useState<Error | null>(null),
    [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++sequence.current;
    try {
      const data = await api<T>(url);
      if (id === sequence.current) {
        setResult({ url, data });
        setError(null);
      }
    } catch (e) {
      if (id === sequence.current)
        setError(e instanceof Error ? e : new Error("Ошибка загрузки"));
    } finally {
      if (id === sequence.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    // refresh updates state only after its fetch promise settles; there is no synchronous effect update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const sequenceRef = sequence;
    const timer = interval
      ? setInterval(() => {
          if (document.visibilityState === "visible") void refresh();
        }, interval)
      : null;
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      sequenceRef.current++;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, interval]);
  return {
    data: result?.url === url ? result.data : null,
    error,
    loading: loading || (!error && result?.url !== url),
    refresh,
  };
}
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={cn("brand", small && "brand-small")}>
      <b>RPM</b>
      <span>CLUB</span>
    </span>
  );
}
export function Spinner() {
  return <LoaderCircle size={18} className="spin" aria-label="Загрузка" />;
}
export function Loading() {
  return (
    <div className="loading-state">
      <Brand />
      <Spinner />
      <span>Готовим ваш RPM Club</span>
    </div>
  );
}
export function Failure({
  error,
  retry,
}: {
  error: Error;
  retry?: () => void;
}) {
  return (
    <div className="empty-state">
      <AlertCircle size={32} />
      <h2>Не удалось продолжить</h2>
      <p role="alert">{error.message}</p>
      {error instanceof ApiError &&
      ["AUTH_REQUIRED", "SESSION_EXPIRED", "ONBOARDING_REQUIRED"].includes(
        error.code,
      ) ? (
        <Link className="button" href="/onboarding">
          Открыть RPM Club <ArrowUpRight size={18} />
        </Link>
      ) : error instanceof ApiError && error.code.startsWith("STAFF_") ? (
        <Link href="/admin/login" className="button">
          Войти в панель
        </Link>
      ) : (
        retry && (
          <button className="button button-outline" onClick={retry}>
            <RefreshCw size={16} />
            Повторить
          </button>
        )
      )}
      <Link className="text-link" href="/contacts">
        Связаться с RPM
      </Link>
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-mark">R</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
const DialogCloseContext = createContext<(() => void) | null>(null);
export function DialogClose({
  children,
  disabled = false,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  const close = useContext(DialogCloseContext);
  return (
    <button
      type="button"
      className="button button-outline"
      disabled={disabled}
      onClick={() => close?.()}
    >
      {children}
    </button>
  );
}
export function Dialog({
  title,
  onClose,
  children,
  protectChanges = false,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  protectChanges?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [dirty, setDirty] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (protectChanges && dirty) setConfirmClose(true);
    else onClose();
  };
  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement;
    d?.showModal();
    return () => {
      d?.close();
      queueMicrotask(() => {
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onChangeCapture={() => {
        if (protectChanges) setDirty(true);
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (confirmClose) setConfirmClose(false);
        else requestClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="icon-button"
          onClick={requestClose}
          aria-label="Закрыть"
          disabled={busy}
        >
          <X size={21} />
        </button>
      </div>
      {confirmClose && (
        <div className="dialog-close-warning" role="alert">
          <p>Изменения не сохранены. Закрыть форму?</p>
          <div className="page-heading-actions">
            <button
              type="button"
              className="button"
              ref={(button) => {
                button?.focus();
              }}
              onClick={() => setConfirmClose(false)}
            >
              Продолжить редактирование
            </button>
            <button
              type="button"
              className="button button-outline"
              onClick={onClose}
            >
              Закрыть без сохранения
            </button>
          </div>
        </div>
      )}
      <DialogCloseContext.Provider value={requestClose}>
        <div hidden={confirmClose}>{children}</div>
      </DialogCloseContext.Provider>
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function FormMessage({
  error,
  success,
}: {
  error?: string | null;
  success?: string | null;
}) {
  return error ? (
    <p className="form-error" role="alert">
      {error}
    </p>
  ) : success ? (
    <p className="form-success" role="status">
      {success}
    </p>
  ) : null;
}
export function TierBadge({ tier, label }: { tier: string; label?: string }) {
  return (
    <span className={"tier-badge tier-" + tier.toLowerCase()}>
      {label ?? tier}
    </span>
  );
}
