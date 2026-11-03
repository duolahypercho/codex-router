import { useCallback, useEffect, useState } from "react";
import { Badge, Button, SectionHeading } from "../components";
import { compactNumber, exactNumber, formatDateTime } from "../lib";
import type { FreePoolMember, FreePoolStatus, RouterControlApi } from "../types";
import type { Translate } from "../i18n";
import "./free-pool.css";

// free/auto's pool, read from this machine's state directory through
// `control free-pool status`: the member order, which members are drained and
// until when, and the pool's own usage rows. Nothing here leaves the box.
export function FreePoolPanel({
  api,
  refreshKey,
  t,
}: {
  api?: RouterControlApi;
  refreshKey?: unknown;
  t: Translate;
}) {
  const [status, setStatus] = useState<FreePoolStatus | undefined>();
  const [error, setError] = useState("");
  const read = useCallback(async () => {
    if (typeof api?.getFreePool !== "function") return;
    try {
      setStatus(await api.getFreePool());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [api]);

  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), 15_000);
    return () => clearInterval(timer);
  }, [read, refreshKey]);

  if (typeof api?.getFreePool !== "function") return null;
  if (!status) {
    return error ? (
      <section className="panel-section fp-panel" aria-label={t("usage.freePool.title")}>
        <SectionHeading title={t("usage.freePool.title")} />
        <p className="fp-error">{error}</p>
      </section>
    ) : null;
  }

  const usage = status.usage;
  const drained = status.members.filter((member) => member.drained).length;
  const enabled = status.enabled !== false;
  const exhausted = status.members.length > 0 && drained === status.members.length;
  const servedBy = new Map(usage.byMember.map((entry) => [entry.model, entry]));
  const summary = [
    { label: t("usage.freePool.requests"), value: exactNumber(usage.requests) },
    { label: t("usage.freePool.served"), value: exactNumber(usage.served) },
    { label: t("usage.freePool.fallbacks"), value: exactNumber(usage.fallbacks) },
    { label: t("usage.freePool.failedAttempts"), value: exactNumber(usage.errors) },
    { label: t("usage.freePool.exhausted"), value: exactNumber(usage.exhausted) },
    { label: t("usage.freePool.inputTokens"), value: compactNumber(usage.inputTokens) },
    { label: t("usage.freePool.outputTokens"), value: compactNumber(usage.outputTokens) },
  ];

  return (
    <section className="panel-section fp-panel" aria-label={t("usage.freePool.title")}>
      <SectionHeading
        title={t("usage.freePool.title")}
        description={t("usage.freePool.description", { model: status.pool })}
        action={(
          <div className="fp-heading-action">
            {!enabled ? (
              <Badge tone="neutral">{t("usage.freePool.disabled")}</Badge>
            ) : exhausted ? (
              <Badge tone="danger">{t("usage.freePool.allDrained")}</Badge>
            ) : drained ? (
              <Badge tone="warning">{t("usage.freePool.someDrained", { drained, total: status.members.length })}</Badge>
            ) : (
              <Badge tone="success">{t("usage.freePool.ready")}</Badge>
            )}
            <Button variant="ghost" onClick={() => void read()}>{t("usage.freePool.reload")}</Button>
          </div>
        )}
      />
      <dl className="fp-summary">
        {summary.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>
      <p className="fp-catalog">
        {status.catalog.source === "live" && status.catalog.fetchedAt
          ? t("usage.freePool.catalogLive", { time: formatDateTime(status.catalog.fetchedAt, t) })
          : t("usage.freePool.catalogStatic")}
      </p>

      <h3 className="fp-subheading">{t("usage.freePool.membersHeading")}</h3>
      <div className="table-list fp-members" role="list" aria-label={t("usage.freePool.membersHeading")}>
        {status.members.map((member) => (
          <MemberRow key={member.slug} member={member} served={servedBy.get(member.slug)?.served ?? 0} t={t} />
        ))}
      </div>

      <h3 className="fp-subheading">{t("usage.freePool.recentHeading")}</h3>
      {usage.recent.length ? (
        <div className="table-list fp-recent" role="list" aria-label={t("usage.freePool.recentHeading")}>
          {usage.recent.map((row, index) => (
            <div className="fp-recent-row" role="listitem" key={`${row.at}-${row.model}-${index}`}>
              <time dateTime={row.at}>{formatDateTime(row.at, t)}</time>
              <code title={row.model}>{row.model}</code>
              <span className={row.status && row.status < 300 ? "fp-ok" : "fp-bad"}>{row.status ?? "-"}</span>
              <span className="fp-detail">
                {row.reason === "exhausted"
                  ? t("usage.freePool.rowExhausted")
                  : row.reason
                    ? t("usage.freePool.rowDrained", { reason: row.reason })
                    : row.failoverFrom
                      ? t("usage.freePool.rowFallback", { from: row.failoverFrom })
                      : ""}
              </span>
              <span className="fp-tokens">
                {t("usage.freePool.rowTokens", {
                  input: compactNumber(row.inputTokens),
                  output: compactNumber(row.outputTokens),
                })}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="fp-empty">{t("usage.freePool.noRequests", { model: status.pool })}</p>
      )}
    </section>
  );
}

function MemberRow({ member, served, t }: { member: FreePoolMember; served: number; t: Translate }) {
  const minutes = Math.max(1, Math.ceil((member.remainingMs ?? 0) / 60_000));
  return (
    <div className="fp-member-row" role="listitem">
      <span className="fp-position">{member.position}</span>
      <code title={member.slug}>{member.upstreamModel}</code>
      <span className="fp-lane">{member.lane === "opencode" ? "OpenCode Zen" : "Kilo"}</span>
      <span className="fp-served">{t("usage.freePool.memberServed", { count: exactNumber(served) })}</span>
      {!member.enabled ? (
        <Badge tone="neutral">{t("usage.freePool.disabled")}</Badge>
      ) : member.drained ? (
        <Badge tone="warning">
          {t("usage.freePool.drainedFor", {
            minutes,
            reason: member.drainReason ?? "",
            status: member.drainStatus ?? "-",
          })}
        </Badge>
      ) : (
        <Badge tone="success">{t("usage.freePool.ready")}</Badge>
      )}
    </div>
  );
}
