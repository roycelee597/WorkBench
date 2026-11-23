import { useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Dialog } from "@workbench/ui";
import { MODULE_CHANNEL_PARAM } from "@workbench/sdk";
import { ModuleBridge, ModuleRateLimiter } from "./bridge";
import { moduleMethods } from "./methods";
import { moduleDataLayer, type ModuleRecord } from "./module-api";

type Notice = { title: string; body?: string };
type Approval = { message: string; resolve: (value: boolean) => void };
const rateLimits = new WeakMap<ModuleRecord, ModuleRateLimiter>();

function frameUrl(url: string, channel: string) {
  const source = new URL(url);
  source.hash = new URLSearchParams({ [MODULE_CHANNEL_PARAM]: channel }).toString();
  return source.href;
}

export function ModuleLoader({
  record,
  onBadge,
}: {
  record: ModuleRecord;
  onBadge: (id: string, count: number) => void;
}) {
  const element = useRef<HTMLIFrameElement>(null);
  const pendingApproval = useRef<Approval | null>(null);
  const [channel] = useState(() => crypto.randomUUID());
  const [caption, setCaption] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const { id, name } = record.manifest;
  useLayoutEffect(() => {
    let active = true;
    let stopChanges: (() => void) | undefined;
    let timer: number | undefined;
    const theme = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");
    const limiter = rateLimits.get(record) ?? new ModuleRateLimiter();
    rateLimits.set(record, limiter);
    const bridge = new ModuleBridge({
      source: () => element.current?.contentWindow ?? null,
      channel,
      permissions: () => record.grants,
      limiter,
      methods: moduleMethods(id, {
        active: () => active,
        permissions: () => record.grants,
        theme,
        notify(title, body) {
          if (!active) return;
          setNotice(body === undefined ? { title } : { title, body });
          window.clearTimeout(timer);
          timer = window.setTimeout(() => setNotice(null), 8_000);
          if (body !== undefined) void invoke("show_main").catch(() => undefined);
        },
        confirm(message) {
          if (!active || pendingApproval.current) return Promise.resolve(false);
          return new Promise<boolean>((resolve) => {
            const next = { message, resolve };
            pendingApproval.current = next;
            setApproval(next);
          });
        },
        setTitle: setCaption,
        setBadge: (count) => onBadge(id, count),
      }),
    });
    const receive = (event: MessageEvent<unknown>) => void bridge.receive(event);
    window.addEventListener("message", receive);
    let previousTheme = theme();
    const observer = new MutationObserver(() => {
      const current = theme();
      if (current !== previousTheme) {
        previousTheme = current;
        bridge.publish("theme-changed", current);
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    if (
      ["memos:read", "reminders:read", "calendar:read"].some((permission) =>
        record.grants.some((grant) => grant === permission),
      )
    ) {
      void moduleDataLayer()
        .then(({ changes }) => {
          if (active) {
            stopChanges = changes.subscribe((tables) => {
              if (tables.has("memos")) bridge.dataChanged("memos");
              if (tables.has("events")) bridge.dataChanged("calendar");
              if (tables.has("reminders") || tables.has("reminder_occurrences"))
                bridge.dataChanged("reminders");
            });
          }
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
      window.removeEventListener("message", receive);
      window.clearTimeout(timer);
      observer.disconnect();
      bridge.close();
      stopChanges?.();
      pendingApproval.current?.resolve(false);
      pendingApproval.current = null;
      onBadge(id, 0);
    };
  }, [channel, id, onBadge, record]);
  function settle(approved: boolean) {
    if (!pendingApproval.current) return;
    pendingApproval.current.resolve(approved);
    pendingApproval.current = null;
    setApproval(null);
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label={name}>
      <header className="flex flex-wrap items-baseline gap-3 border-b border-border px-6 py-3">
        <h1 className="text-lg font-semibold">{name}</h1>
        {caption && caption !== name && (
          <span className="text-sm text-muted-foreground">{caption}</span>
        )}
      </header>
      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 border-b border-border bg-card px-6 py-3"
        >
          <div className="min-w-0 break-words">
            <p className="font-medium">{notice.title}</p>
            {notice.body && <p className="text-sm text-muted-foreground">{notice.body}</p>}
          </div>
          <Button size="sm" variant="outline" onClick={() => setNotice(null)}>
            关闭通知
          </Button>
        </div>
      )}
      <iframe
        ref={element}
        title={name}
        src={frameUrl(record.url, channel)}
        sandbox="allow-scripts allow-forms"
        referrerPolicy="no-referrer"
        className="w-full min-h-0 flex-1 border-0"
      />
      <Dialog
        open={approval !== null}
        onOpenChange={(open) => {
          if (!open) settle(false);
        }}
        title={`${name} 请求确认`}
        description={approval?.message ?? ""}
        footer={
          <>
            <Button variant="outline" autoFocus onClick={() => settle(false)}>
              取消
            </Button>
            <Button onClick={() => settle(true)}>确认</Button>
          </>
        }
      />
    </section>
  );
}
