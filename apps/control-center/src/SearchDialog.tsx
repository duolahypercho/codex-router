import { useEffect, useMemo, useRef, useState } from "react";
import { Search, type LucideIcon } from "lucide-react";
import type { ViewId } from "./types";
import { useI18n } from "./i18n-react";
import "./search-dialog.css";

export interface SearchDialogItem {
  id: ViewId;
  label: string;
  description: string;
  icon: LucideIcon;
}

interface SearchDialogProps {
  activeView: ViewId;
  items: readonly SearchDialogItem[];
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
}

export function SearchDialog({ activeView, items, onClose, onNavigate }: SearchDialogProps) {
  const t = useI18n();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${item.label} ${item.description}`.toLocaleLowerCase().includes(needle),
    );
  }, [items, query]);

  useEffect(() => {
    inputRef.current?.focus();

    const handleDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDocumentKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(results.length - 1, 0)));
  }, [results.length]);

  const chooseResult = (view: ViewId) => {
    onNavigate(view);
    onClose();
  };

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => results.length ? (current + 1) % results.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => results.length
        ? (current - 1 + results.length) % results.length
        : 0);
    } else if (event.key === "Home" && results.length) {
      event.preventDefault();
      setSelectedIndex(0);
    } else if (event.key === "End" && results.length) {
      event.preventDefault();
      setSelectedIndex(results.length - 1);
    } else if (event.key === "Enter" && results[selectedIndex]) {
      event.preventDefault();
      chooseResult(results[selectedIndex].id);
    }
  };

  return (
    <div
      className="search-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("app.search.aria")}
      >
        <div className="search-dialog-input-row">
          <Search aria-hidden size={19} strokeWidth={1.65} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder={t("searchDialog.placeholder")}
            aria-label={t("searchDialog.inputAria")}
            aria-controls="control-center-search-results"
            aria-activedescendant={results[selectedIndex]
              ? `control-center-search-${results[selectedIndex].id}`
              : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleInputKeyDown}
          />
          <kbd>esc</kbd>
        </div>

        <div className="search-dialog-section-label" id="control-center-search-label">
          {t("searchDialog.sections")}
          <span aria-live="polite">{results.length === 1 ? t("searchDialog.resultCountOne", { count: results.length }) : t("searchDialog.resultCount", { count: results.length })}</span>
        </div>

        <div
          className="search-dialog-results"
          id="control-center-search-results"
          role="listbox"
          aria-labelledby="control-center-search-label"
        >
          {results.map((item, index) => {
            const Icon = item.icon;
            const selected = index === selectedIndex;
            const active = item.id === activeView;
            return (
              <button
                id={`control-center-search-${item.id}`}
                className={selected ? "is-selected" : ""}
                type="button"
                role="option"
                aria-selected={selected}
                key={item.id}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => chooseResult(item.id)}
              >
                <span className="search-dialog-result-icon"><Icon aria-hidden size={17} strokeWidth={1.65} /></span>
                <span className="search-dialog-result-copy">
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                {active ? <span className="search-dialog-current">{t("searchDialog.current")}</span> : null}
              </button>
            );
          })}

          {!results.length ? (
            <div className="search-dialog-empty" role="status">
              <strong>{t("searchDialog.emptyTitle")}</strong>
              <span>{t("searchDialog.emptyBody")}</span>
            </div>
          ) : null}
        </div>

        <footer className="search-dialog-hints" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t("searchDialog.hintNavigate")}</span>
          <span><kbd>↵</kbd> {t("searchDialog.hintOpen")}</span>
          <span><kbd>esc</kbd> {t("searchDialog.hintClose")}</span>
        </footer>
      </div>
    </div>
  );
}
