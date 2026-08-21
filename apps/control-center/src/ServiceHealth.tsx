import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CheckCircle2, ChevronDown, CircleAlert, CircleDashed, CircleOff } from "lucide-react";
import { Badge, Button } from "./components";
import { serviceHealthRows, type ServiceHealthRow } from "./service-health";
import type { RouterHealth } from "./types";

export function ServiceHealthPanel({ health, compact = false, onOpen, onRepair, repairing = false }: {
  health?: RouterHealth;
  compact?: boolean;
  onOpen?: () => void;
  onRepair?: () => void;
  repairing?: boolean;
}) {
  const rows = serviceHealthRows(health);
  const attention = rows.filter((row) => row.state === "offline" || row.state === "degraded").length;
  const summary = attention ? `${attention} needs attention` : rows.every((row) => row.state === "ready" || row.state === "standby") ? "All clear" : "Checking";
  const [detailsOpen, setDetailsOpen] = useState(attention > 0);
  const previousAttention = useRef(attention);

  // A new problem should reveal its detail, but polling health every second
  // must never override the operator's own open/closed choice.
  useEffect(() => {
    if (attention > previousAttention.current) setDetailsOpen(true);
    previousAttention.current = attention;
  }, [attention]);

  return compact ? (
    <section className="service-health-strip" aria-label="Service health">
      <div className="service-health-strip-heading">
        <span className="service-health-kicker">Service health</span>
        <Badge tone={attention ? "warning" : health ? "success" : "neutral"}>{summary}</Badge>
        {onOpen ? <button type="button" className="service-health-open" onClick={onOpen}>Details <ArrowUpRight aria-hidden size={11} strokeWidth={1.8} /></button> : null}
      </div>
      <div className="service-health-chip-list">
        {rows.map((row) => <ServiceHealthChip key={row.id} row={row} />)}
      </div>
    </section>
  ) : (
    <section className="panel-section service-health-panel">
      <details
        className="service-health-accordion"
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary>
          <span className="service-health-summary-copy">
            <strong>Service health</strong>
            <small>{attention ? "A local dependency needs attention." : "Router and local dependencies."}</small>
          </span>
          <span className="service-health-summary-status">
            <Badge tone={attention ? "warning" : health ? "success" : "neutral"}>{summary}</Badge>
            <ChevronDown aria-hidden size={15} strokeWidth={1.7} />
          </span>
        </summary>
        <div className="service-health-details">
          <div className="service-health-actions">
            {onRepair && attention ? (
              <Button variant="secondary" disabled={repairing} onClick={onRepair}>
                {repairing ? "Repairing…" : "Fix"}
              </Button>
            ) : null}
          </div>
          <div className="service-health-list" role="list" aria-label="Router service health">
            {rows.map((row) => <ServiceHealthRowView key={row.id} row={row} />)}
          </div>
        </div>
      </details>
    </section>
  );
}

function ServiceHealthRowView({ row }: { row: ServiceHealthRow }) {
  const Icon = row.state === "ready"
    ? CheckCircle2
    : row.state === "offline"
      ? CircleOff
      : row.state === "degraded"
        ? CircleAlert
        : CircleDashed;
  return (
    <article className={`service-health-row is-${row.state}`} role="listitem">
      <Icon aria-hidden size={15} strokeWidth={1.7} />
      <span className="service-health-copy">
        <strong>{row.label}</strong>
        <small>{row.detail}</small>
      </span>
      <Badge tone={row.tone}>{row.status}</Badge>
    </article>
  );
}

function ServiceHealthChip({ row }: { row: ServiceHealthRow }) {
  return (
    <span className={`service-health-chip is-${row.state}`} title={`${row.label}: ${row.detail}`}>
      <i aria-hidden="true" />
      <strong>{row.label}</strong>
      <small>{row.status}</small>
    </span>
  );
}
