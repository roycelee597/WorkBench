import { Fragment } from "react";
import type { ResultItem } from "../../../../apps/desktop/src/core/ai/action-types";
import type { AiStore } from "../ai-store";

const badges = {
  repeat: "重复",
  remind: "有提前提醒",
  finance: "金融",
  completed: "已完成",
  "event-linked": "日程生成",
};
export function ReferenceButton({
  item,
  store,
  compact = false,
  financeAvailable,
}: {
  item: ResultItem;
  store: AiStore;
  compact?: boolean;
  financeAvailable: boolean;
}) {
  const error = store((state) => state.navigationErrors[item.id]);
  const opening = store((state) => state.openingReference === item.id);
  const label = compact ? `[${item.id}]` : `${item.when} · ${item.title}（${item.id}）`;
  if (!financeAvailable && item.badges.includes("finance"))
    return <span className="text-muted-foreground">{label}（金融模块未安装或已停用）</span>;
  return (
    <>
      <button
        type="button"
        className="text-left text-primary underline underline-offset-2"
        disabled={opening}
        onClick={() => void store.getState().openReference(item.id)}
      >
        {label}
      </button>
      {error && (
        <span className="ml-2 text-sm text-destructive" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

export function ReadResults({
  items,
  empty,
  store,
  financeAvailable,
}: {
  items: ResultItem[];
  empty: string;
  store: AiStore;
  financeAvailable: boolean;
}) {
  const enabled = store((state) => state.readEnabled);
  const known = store((state) => state.refItems);
  if (!enabled || items.some((item) => !known[item.id]))
    return <p className="ai-message-note">历史读取结果已隐藏，请重新查询。</p>;
  return (
    <div className="space-y-2">
      <p>{items.length ? "查到的内容" : empty}</p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id}>
            <ReferenceButton item={item} store={store} financeAvailable={financeAvailable} />
            {item.badges.map((badge) => (
              <span key={badge} className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                {badges[badge]}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 只把本地已发出且已知的短引用变成按钮，不解析 HTML、Markdown 或任意链接。 */
export function ReferencedText({
  text,
  store,
  financeAvailable,
}: {
  text: string;
  store: AiStore;
  financeAvailable: boolean;
}) {
  const items = store((state) => state.refItems);
  const enabled = store((state) => state.readEnabled);
  return (
    <p>
      {text
        .split(/(\[[er][1-9]\d*\])/)
        .map((part, index) =>
          enabled && index % 2 === 1 && items[part.slice(1, -1)] ? (
            <ReferenceButton
              key={index}
              item={items[part.slice(1, -1)]!}
              store={store}
              compact
              financeAvailable={financeAvailable}
            />
          ) : (
            <Fragment key={index}>{part}</Fragment>
          ),
        )}
    </p>
  );
}
