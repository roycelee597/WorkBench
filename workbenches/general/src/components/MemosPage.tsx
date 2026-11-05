import { FileText, Plus, Search, Pin, SlidersHorizontal, ArrowUpRight } from "lucide-react";
import { Button, cn } from "@workbench/ui";
import { filterMemos, knownTags, memoTitle } from "../api";
import { markdownSummary } from "../markdown";
import { workspace } from "../workspace-store";
import { MemoEditor } from "./MemoEditor";

function updatedLabel(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
export function MemosPage() {
  const state = workspace.useWorkspace();
  const memos = filterMemos(state.memos, { query: state.query, tag: state.tag });
  const selected = state.memos.find((memo) => memo.id === state.selectedId);
  const tags = knownTags(state.memos);
  return (
    <div className="memos-page">
      <aside className="memo-list-pane" aria-label="备忘录列表">
        <div className="memo-list-heading">
          <h2>
            备忘录 <span>{state.memos.length}</span>
          </h2>
          <Button size="sm" onClick={() => void state.createMemo()} disabled={state.busy}>
            <Plus />
            新建
          </Button>
        </div>
        <div className="memo-list-controls">
          <div className="search-box">
            <Search size={15} />
            <input
              aria-label="搜索备忘录"
              placeholder="搜索标题、正文或标签"
              value={state.query}
              onChange={(event) => state.setQuery(event.target.value)}
            />
          </div>
          <div className="filter-row">
            <SlidersHorizontal size={13} />
            <select
              aria-label="按标签筛选"
              value={state.tag}
              onChange={(event) => state.setTag(event.target.value)}
            >
              <option value="">所有标签</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
            <span>{memos.length} 条</span>
          </div>
        </div>
        <div className="memo-list" role="list" aria-label="搜索结果">
          {memos.map((memo) => (
            <div role="listitem" key={memo.id}>
              <button
                type="button"
                className={cn("memo-card", memo.id === state.selectedId && "selected")}
                aria-current={memo.id === state.selectedId}
                disabled={state.busy}
                onClick={() => void state.selectMemo(memo.id)}
              >
                <div className="memo-card-title">
                  {memo.pinned && <Pin size={12} className="text-primary" />}
                  <h3>{memoTitle(memo)}</h3>
                </div>
                <p className="memo-card-preview">
                  {markdownSummary(memo.content) || "还没有正文，写下第一个想法吧。"}
                </p>
                <div className="memo-card-bottom">
                  <time dateTime={new Date(memo.updated_at).toISOString()}>
                    {updatedLabel(memo.updated_at)}
                  </time>
                  <span>
                    {memo.tags.slice(0, 2).map((tag) => (
                      <span key={tag} className="list-tag">
                        {tag}
                      </span>
                    ))}
                  </span>
                </div>
              </button>
            </div>
          ))}
          {memos.length === 0 && (
            <div className="list-empty">
              <Search size={22} />
              <p>{state.query || state.tag ? "没有找到匹配的备忘录" : "还没有备忘录"}</p>
              <span>
                {state.query || state.tag ? "换个关键词或标签试试" : "点击新建，开始记录"}
              </span>
            </div>
          )}
        </div>
        <div className="list-caption">
          <span className="status-dot" />
          想法随手记，修改自动保存
        </div>
      </aside>
      {selected ? (
        <MemoEditor key={selected.id} memo={selected} />
      ) : (
        <section className="editor-empty">
          <div className="empty-icon">
            <FileText size={30} strokeWidth={1.4} />
          </div>
          <h2>给想法留个位置</h2>
          <p>灵感、计划，或只是此刻想记住的小事。</p>
          <Button className="mt-5" onClick={() => void state.createMemo()} disabled={state.busy}>
            <Plus />
            新建备忘录
            <ArrowUpRight size={14} />
          </Button>
          <span className="empty-footnote">你的文字，只属于你。</span>
        </section>
      )}
    </div>
  );
}
