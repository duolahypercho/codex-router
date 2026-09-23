import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, RefreshCw, Search, X } from "lucide-react";
import { classNames } from "./lib";
import { useI18n } from "./i18n-react";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "accent" }) {
  return <span className={classNames("badge", `badge-${tone}`)}>{children}</span>;
}

export function Button({ className, variant = "secondary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={classNames("button", `button-${variant}`, className)} {...props} />;
}

export function Toggle({ checked, onChange, disabled = false, label }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className={classNames("toggle", disabled && "is-disabled")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span aria-hidden="true"><i /></span>
    </label>
  );
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  const t = useI18n();
  return (
    <label className="search-field">
      <Search aria-hidden size={14} strokeWidth={1.7} />
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder ?? t("common.search")} />
      {value ? (
        <button type="button" aria-label={t("common.clearSearch")} onClick={() => onChange("")}>
          <X aria-hidden size={13} strokeWidth={1.7} />
        </button>
      ) : null}
    </label>
  );
}

export function PageHeader({ eyebrow, title, description, onRefresh, refreshing, actions }: { eyebrow: string; title: string; description: string; onRefresh?: () => void; refreshing?: boolean; actions?: ReactNode }) {
  const t = useI18n();
  return (
    <header className="page-header">
      <div>
        <p className="page-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      <div className="page-actions">
        {actions}
        {onRefresh ? (
          <Button variant="ghost" aria-label={t("common.refreshTitle", { title })} onClick={onRefresh} disabled={refreshing}>
            <RefreshCw aria-hidden size={14} strokeWidth={1.7} className={refreshing ? "spin" : ""} />
            {t("common.refresh")}
          </Button>
        ) : null}
      </div>
    </header>
  );
}

export function StatStrip({ items }: { items: Array<{ label: string; value: ReactNode; detail?: string }> }) {
  return (
    <dl className="stat-strip">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.detail ? <small>{item.detail}</small> : null}
        </div>
      ))}
    </dl>
  );
}

export function SectionHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const t = useI18n();
  return (
    <div className="loading-state app-loading-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label ?? t("common.loadingRouterData")}</span>
      <div className="skeleton-heading">
        <SkeletonBlock className="skeleton-eyebrow" />
        <SkeletonBlock className="skeleton-title" />
        <SkeletonBlock className="skeleton-copy" />
      </div>
      <div className="skeleton-stat-grid" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <SkeletonBlock key={index} className="skeleton-stat" />)}
      </div>
      <SkeletonBlock className="skeleton-panel" />
      <div className="skeleton-directory" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => <SkeletonBlock key={index} className="skeleton-row" />)}
      </div>
    </div>
  );
}

export function SkeletonBlock({ className = "" }: { className?: string }) {
  return <i className={classNames("skeleton-block", className)} aria-hidden="true" />;
}

export function CatalogSkeleton({ label }: { label?: string }) {
  const t = useI18n();
  return (
    <div className="catalog-skeleton" role="status" aria-live="polite">
      <span className="visually-hidden">{label ?? t("common.loadingProviderCatalog")}</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div className="catalog-skeleton-row" key={index} aria-hidden="true">
          <SkeletonBlock className="skeleton-check" />
          <SkeletonBlock className="skeleton-catalog-name" />
          <SkeletonBlock className="skeleton-catalog-meta" />
        </div>
      ))}
    </div>
  );
}

export function PanelSkeleton({ label, variant = "list", count = 4 }: { label?: string; variant?: "list" | "cards"; count?: number }) {
  const t = useI18n();
  return (
    <div className={classNames("panel-skeleton", `panel-skeleton-${variant}`)} role="status" aria-live="polite">
      <span className="visually-hidden">{label ?? t("common.loadingContent")}</span>
      {Array.from({ length: count }, (_, index) => <SkeletonBlock className="panel-skeleton-item" key={index} />)}
    </div>
  );
}

export function InlineNotice({ tone = "neutral", title, children }: { tone?: "neutral" | "success" | "warning" | "danger"; title: string; children?: ReactNode }) {
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <div className={classNames("inline-notice", `notice-${tone}`)}>
      <Icon aria-hidden size={16} strokeWidth={1.7} />
      <div><strong>{title}</strong>{children ? <p>{children}</p> : null}</div>
    </div>
  );
}

export function Dialog({ open, title, description, children, onClose }: { open: boolean; title: string; description?: string; children: ReactNode; onClose: () => void }) {
  const t = useI18n();
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const backdrop = backdropRef.current;
    const panel = panelRef.current;
    if (!backdrop || !panel) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    // `aria-modal` describes the relationship to assistive technology; inert
    // enforces the same boundary for keyboard and pointer input. Preserve a
    // pre-existing inert owner so nested application shells remain untouched.
    const siblings = backdrop.parentElement
      ? [...backdrop.parentElement.children].filter((element): element is HTMLElement => (
        element instanceof HTMLElement && element !== backdrop
      ))
      : [];
    const priorInert = siblings.map((element) => [element, element.inert] as const);
    for (const element of siblings) element.inert = true;

    panel.focus({ preventScroll: true });
    const focusableElements = () => [...panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      for (const [element, inert] of priorInert) element.inert = inert;
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  // Portalling to body makes the backdrop a sibling of the complete app root,
  // so the inert boundary covers navigation, title bar, and page content --
  // not only the Settings column that happened to open the dialog.
  return createPortal((
    <div ref={backdropRef} className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        ref={panelRef}
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button className="icon-button" type="button" aria-label={t("common.closeDialog")} onClick={onClose}>
            <X aria-hidden size={16} strokeWidth={1.7} />
          </button>
        </header>
        {children}
      </section>
    </div>
  ), document.body);
}
