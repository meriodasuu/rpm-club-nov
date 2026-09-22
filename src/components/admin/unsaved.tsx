"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import { Dialog } from "@/components/shared";
const dirtyForms = new Set<{ current: boolean }>();
let askForExit: ((resolve: (answer: boolean) => void) => void) | null = null;
let pendingExit: Promise<boolean> | null = null;
export async function confirmUnsavedExit(): Promise<boolean> {
  if (![...dirtyForms].some((form) => form.current)) return true;
  if (!askForExit) return false;
  if (!pendingExit)
    pendingExit = new Promise<boolean>((resolve) => askForExit?.(resolve)).then(
      (answer) => {
        if (answer) for (const form of dirtyForms) form.current = false;
        pendingExit = null;
        return answer;
      },
    );
  return pendingExit;
}
export function UnsavedChangesPrompt() {
  const [answer, setAnswer] = useState<((answer: boolean) => void) | null>(
    null,
  );
  useEffect(() => {
    const show = (resolve: (answer: boolean) => void) =>
      setAnswer(() => resolve);
    askForExit = show;
    return () => {
      if (askForExit === show) askForExit = null;
    };
  }, []);
  const finish = (value: boolean) => {
    answer?.(value);
    setAnswer(null);
  };
  return answer ? (
    <Dialog title="Изменения не сохранены" onClose={() => finish(false)}>
      <p>При уходе со страницы введённые изменения будут потеряны.</p>
      <div className="page-heading-actions">
        <button type="button" className="button" onClick={() => finish(false)}>
          Продолжить редактирование
        </button>
        <button
          type="button"
          className="button button-outline"
          onClick={() => finish(true)}
        >
          Уйти без сохранения
        </button>
      </div>
    </Dialog>
  ) : null;
}
export function useUnsavedChanges() {
  const dirty = useRef(false);
  const markDirty = useCallback(() => {
    dirty.current = true;
  }, []);
  const markSaved = useCallback(() => {
    dirty.current = false;
  }, []);
  useEffect(() => {
    dirtyForms.add(dirty);
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const navigate = (event: MouseEvent) => {
      if (
        !dirty.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(link instanceof HTMLAnchorElement) ||
        link.target === "_blank" ||
        link.hasAttribute("download")
      )
        return;
      const url = new URL(link.href);
      if (
        url.pathname === location.pathname &&
        url.search === location.search &&
        url.origin === location.origin
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      void confirmUnsavedExit().then((confirmed) => {
        if (confirmed) window.location.assign(url.href);
      });
    };
    const navigation = (
      window as Window & {
        navigation?: EventTarget & { traverseTo?: (key: string) => unknown };
      }
    ).navigation;
    const historyNavigation = (event: Event) => {
      const e = event as Event & {
        navigationType?: string;
        destination?: { key: string; url: string };
      };
      if (
        e.navigationType !== "traverse" ||
        !dirty.current ||
        !e.cancelable ||
        e.defaultPrevented ||
        !e.destination
      )
        return;
      e.preventDefault();
      const destination = e.destination;
      void confirmUnsavedExit().then((confirmed) => {
        if (confirmed) {
          if (navigation?.traverseTo) navigation.traverseTo(destination.key);
          else window.location.assign(destination.url);
        }
      });
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    navigation?.addEventListener("navigate", historyNavigation);
    return () => {
      dirtyForms.delete(dirty);
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", navigate, true);
      navigation?.removeEventListener("navigate", historyNavigation);
    };
  }, []);
  return { markDirty, markSaved };
}
