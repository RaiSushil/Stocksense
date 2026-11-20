// Ask StockSense: chat panel used by the floating launcher (drawer) and the full
// page. Conversations are saved per shop and listed like a chat history,
// grouped by day, with rename and delete.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useFetcher } from "react-router";
import { SeriesChart, StockCurve, type ChartSpec } from "./charts";
import type { loader as askLoader, action as askAction } from "../routes/app.ask-api";

const ACTIVE_KEY = "stocksense-ask-thread";
const EXAMPLES = [
  "Which variants will run dry before Black Friday?",
  "What overstock is tying up the most cash?",
  "Which supplier is getting slower?",
  "What should I reorder this week, and from whom?",
];

type Data = Awaited<ReturnType<typeof askLoader>>;
type Msg = Data["messages"][number];

function readActive() {
  try {
    return window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}
function writeActive(id: string | null) {
  try {
    if (id) window.localStorage.setItem(ACTIVE_KEY, id);
    else window.localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // ignore
  }
}

export function AskPanel({ mode, onClose }: { mode: "drawer" | "page"; onClose?: () => void }) {
  const data = useFetcher<typeof askLoader>();
  const send = useFetcher<typeof askAction>();
  const manage = useFetcher<typeof askAction>();
  const [view, setView] = useState<"chat" | "history">("chat");
  // The conversation on screen is whichever one the data endpoint last returned.
  const active = data.data?.threadId ?? null;
  const ready = data.data !== undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const load = (id: string | null) => data.load(`/app/ask-api${id ? `?thread=${id}` : ""}`);

  // Restore the last conversation on open.
  useEffect(() => {
    load(readActive());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After an answer arrives, switch to its conversation and reload.
  useEffect(() => {
    if (send.state === "idle" && send.data) {
      const id = (send.data as { threadId?: string | null }).threadId ?? null;
      if (id) writeActive(id);
      load(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send.state, send.data]);

  useEffect(() => {
    if (manage.state === "idle" && manage.data) {
      const d = manage.data as { deleted?: string };
      if (d.deleted && d.deleted === active) {
        writeActive(null);
        load(null);
      } else load(active);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manage.state, manage.data]);

  const d = data.data;
  const pending = send.state !== "idle";
  const pendingQuestion = pending ? String(send.formData?.get("question") ?? "") : "";
  const error = send.state === "idle" ? (send.data as { error?: string } | undefined)?.error : undefined;
  const messages = d?.messages ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, pending]);

  const open = (id: string | null) => {
    writeActive(id);
    load(id);
    setView("chat");
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const submit = (question: string) => {
    if (!question.trim() || pending) return;
    send.submit({ intent: "send", question, threadId: active ?? "" }, { method: "post", action: "/app/ask-api" });
  };

  const title = d?.threads.find((t) => t.id === active)?.title ?? "New conversation";

  const history = (
    <History
      threads={d?.threads ?? []}
      active={active}
      onOpen={open}
      onRename={(id, t) => manage.submit({ intent: "rename", threadId: id, title: t }, { method: "post", action: "/app/ask-api" })}
      onDelete={(id) => manage.submit({ intent: "delete", threadId: id }, { method: "post", action: "/app/ask-api" })}
    />
  );

  const chat = (
    <div className="ss-ask-chat">
      <div className="ss-ask-scroll" ref={scrollRef}>
        {d && !d.allowed ? (
          <div className="ss-ask-empty">
            <Spark size={34} />
            <h3>Ask your inventory anything</h3>
            <p>Plain-English answers with charts, grounded in your own data. Available on the Scale and Pro plans.</p>
            <Link className="ss-btn primary" to="/app/billing">
              See plans
            </Link>
          </div>
        ) : messages.length === 0 && !pending ? (
          <div className="ss-ask-empty">
            <Spark size={34} />
            <h3>What do you want to know?</h3>
            <p>Answers come from your catalog, orders, forecasts and suppliers, with a chart when it helps.</p>
            <div className="ss-ask-examples">
              {EXAMPLES.map((q) => (
                <button key={q} type="button" className="ss-chip" onClick={() => submit(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <Message key={m.id} m={m} />
            ))}
            {pending && (
              <>
                <Message m={{ id: "pending", role: "user", content: pendingQuestion, createdAt: "", charts: [], po: null }} />
                <div className="ss-ask-typing">
                  <span />
                  <span />
                  <span />
                  <em>Checking forecasts, orders and suppliers</em>
                </div>
              </>
            )}
          </>
        )}
        {error && <div className="ss-ask-error">{error}</div>}
        {d && !d.configured && d.allowed && <div className="ss-ask-error">ANTHROPIC_API_KEY is not set on the server, so answers are turned off.</div>}
      </div>
      <form
        className="ss-ask-input"
        onSubmit={(e) => {
          e.preventDefault();
          const el = inputRef.current;
          if (!el) return;
          submit(el.value);
          el.value = "";
          el.style.height = "";
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={d && !d.allowed ? "Upgrade to ask questions" : "Ask about stock, demand, suppliers or orders"}
          disabled={!!d && !d.allowed}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(160, el.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" className="ss-ask-send" disabled={pending || (!!d && !d.allowed)} aria-label="Send">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </form>
      <div className="ss-ask-foot">
        {d?.quota !== null && d?.quota !== undefined ? `${d.used} of ${d.quota} questions this month` : "Unlimited questions"} · Enter to send, Shift+Enter
        for a new line
      </div>
    </div>
  );

  if (mode === "page") {
    return (
      <div className="ss-ask-page">
        <aside className="ss-ask-side">
          <button type="button" className="ss-btn primary block" onClick={() => open(null)}>
            + New chat
          </button>
          {history}
        </aside>
        <section className="ss-ask-main">
          <header className="ss-ask-head">
            <div className="ss-ask-title">
              <Spark />
              <span>{active ? title : "New conversation"}</span>
            </div>
          </header>
          {ready && chat}
        </section>
      </div>
    );
  }

  return (
    <div className="ss-ask-drawer" role="dialog" aria-label="Ask StockSense">
      <header className="ss-ask-head">
        <div className="ss-ask-title">
          <Spark />
          <div>
            <b>Ask StockSense</b>
            <span>{view === "history" ? "Your conversations" : active ? title : "New conversation"}</span>
          </div>
        </div>
        <div className="ss-ask-actions">
          <IconBtn label="Conversations" pressed={view === "history"} onClick={() => setView(view === "history" ? "chat" : "history")}>
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5M12 7v5l3 2" />
          </IconBtn>
          <IconBtn label="New chat" onClick={() => open(null)}>
            <path d="M12 5v14M5 12h14" />
          </IconBtn>
          <Link className="ss-icon-btn" to={active ? `/app/ask?thread=${active}` : "/app/ask"} title="Open full page" aria-label="Open full page" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
            </svg>
          </Link>
          <IconBtn label="Close" onClick={() => onClose?.()}>
            <path d="M6 6l12 12M18 6L6 18" />
          </IconBtn>
        </div>
      </header>
      {view === "history" ? (
        <div className="ss-ask-scroll">
          <button type="button" className="ss-btn primary block" onClick={() => open(null)} style={{ marginBottom: 12 }}>
            + New chat
          </button>
          {history}
        </div>
      ) : (
        ready && chat
      )}
    </div>
  );
}

function IconBtn({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="ss-icon-btn" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

export function Spark({ size = 18 }: { size?: number }) {
  return (
    <span className="ss-spark" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="currentColor" aria-hidden="true">
        <path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z" />
        <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" opacity=".7" />
      </svg>
    </span>
  );
}

function History({
  threads,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  threads: Data["threads"];
  active: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const groups = useMemo(() => groupByDay(threads), [threads]);
  if (!threads.length) return <p className="ss-muted ss-small">No conversations yet. Your chats are saved here.</p>;
  return (
    <div className="ss-ask-history">
      {groups.map(([label, items]) => (
        <div key={label}>
          <div className="ss-ask-group">{label}</div>
          {items.map((t) => (
            <div key={t.id} className={`ss-ask-thread${t.id === active ? " active" : ""}`}>
              {editing === t.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = String(new FormData(e.currentTarget).get("title") ?? "");
                    onRename(t.id, v);
                    setEditing(null);
                  }}
                  style={{ flex: 1 }}
                >
                  <input className="ss-input" name="title" defaultValue={t.title} ref={(el) => el?.focus()} onBlur={(e) => e.currentTarget.form?.requestSubmit()} aria-label="Conversation name" />
                </form>
              ) : (
                <button type="button" className="ss-ask-thread-open" onClick={() => onOpen(t.id)} title={t.title}>
                  {t.title}
                </button>
              )}
              <span className="ss-ask-thread-tools">
                <button type="button" aria-label="Rename" title="Rename" onClick={() => setEditing(t.id)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z" />
                  </svg>
                </button>
                <button
                  type="button"
                  aria-label="Delete"
                  title="Delete"
                  onClick={() => {
                    if (window.confirm(`Delete "${t.title}"?`)) onDelete(t.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
                  </svg>
                </button>
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function groupByDay(threads: Data["threads"]): [string, Data["threads"]][] {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(new Date());
  const order = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];
  const map = new Map<string, Data["threads"]>();
  for (const t of threads) {
    const diff = Math.round((today - startOfDay(new Date(t.updatedAt))) / 86_400_000);
    const label = diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff <= 7 ? "Previous 7 days" : diff <= 30 ? "Previous 30 days" : "Older";
    map.set(label, [...(map.get(label) ?? []), t]);
  }
  return order.filter((l) => map.has(l)).map((l) => [l, map.get(l)!]);
}

function Message({ m }: { m: Msg }) {
  const isUser = m.role === "user";
  return (
    <div className={`ss-msg ${isUser ? "user" : "assistant"}`}>
      {!isUser && (
        <div className="ss-msg-avatar">
          <Spark size={26} />
        </div>
      )}
      <div className="ss-msg-body">
        {isUser ? <div className="ss-msg-user">{m.content}</div> : <RichText text={m.content} />}
        {(m.charts as AnyChart[]).map((c, i) => (
          <div className="ss-msg-chart" key={i}>
            {c.kind === "stock" ? (
              <>
                <div className="ss-msg-chart-title">{c.title}</div>
                <StockCurve past={c.past} now={c.now} future={c.future} reorderPoint={c.reorderPoint} crossingDay={c.crossingDay} leadTimeDay={c.leadTimeDay} today={c.today} height={180} />
              </>
            ) : (
              <>
                {c.spec.title && <div className="ss-msg-chart-title">{c.spec.title}</div>}
                <SeriesChart spec={c.spec} />
              </>
            )}
          </div>
        ))}
        {m.po && (
          <div className="ss-draft">
            <div>
              <div className="ss-bubble-label" style={{ marginBottom: 2 }}>
                {m.po.status === "DRAFT" ? "Draft ready" : m.po.status.toLowerCase()}
              </div>
              <span className="ss-mono">{m.po.number}</span>
              <span className="ss-muted"> · {m.po.status === "DRAFT" ? "waiting for your approval" : "in progress"}</span>
            </div>
            <Link className="ss-btn small primary" to={`/app/purchase-orders/${m.po.id}`}>
              Review
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

type AnyChart =
  | { kind: "series"; spec: ChartSpec }
  | { kind: "stock"; title: string; past: number[]; now: number; future: number[]; reorderPoint: number; crossingDay: number | null; leadTimeDay: number; today: string };

/** Minimal formatting for answers: paragraphs, "- " bullets, **bold** and `code`. */
function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      blocks.push(
        <ul key={`u${blocks.length}`}>
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flush();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
  }
  flush();
  return <div className="ss-msg-text">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith("**") ? <strong key={m.index}>{tok.slice(2, -2)}</strong> : <code key={m.index}>{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/** Floating launcher shown on every page. */
export function AskLauncher() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      {open && <div className="ss-ask-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}
      {open && <AskPanel mode="drawer" onClose={() => setOpen(false)} />}
      {!open && (
        <button type="button" className="ss-ask-fab" onClick={() => setOpen(true)} aria-label="Ask StockSense" title="Ask StockSense (Ctrl+J)">
          <Spark size={30} />
          <span>Ask StockSense</span>
        </button>
      )}
    </>
  );
}
