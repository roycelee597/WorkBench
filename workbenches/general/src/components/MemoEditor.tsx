import { useState } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  Bold,
  Italic,
  Strikethrough,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  CodeSquare,
  Link2,
  Undo2,
  Redo2,
  Pin,
  Trash2,
  Check,
  LoaderCircle,
  CircleAlert,
} from "lucide-react";
import { Button, cn, Dialog } from "@workbench/ui";
import { applyMemoLink, memoExtensions } from "../markdown";
import { knownTags, type Memo } from "../api";
import { workspace } from "../workspace-store";
import { TagInput } from "./TagInput";

export function MemoEditor({ memo }: { memo: Memo }) {
  const state = workspace.useWorkspace();
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [linkError, setLinkError] = useState("");
  const [notice, setNotice] = useState("");
  const editor = useEditor({
    extensions: memoExtensions(),
    content: memo.content,
    contentType: "markdown",
    injectCSS: false,
    onUpdate: ({ editor }) => state.editMemo(memo.id, { content: editor.getMarkdown() }),
    editorProps: {
      attributes: {
        class: "memo-prose",
        "aria-label": "备忘录正文",
        role: "textbox",
        "aria-multiline": "true",
      },
      handlePaste: (_view, event) => {
        if (event.clipboardData?.files.length) {
          setNotice("暂不支持图片和附件。");
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        if (event.dataTransfer?.files.length) {
          event.preventDefault();
          setNotice("暂不支持图片和附件。");
          return true;
        }
        return false;
      },
    },
  });
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive("bold"),
      italic: editor?.isActive("italic"),
      strike: editor?.isActive("strike"),
      bulletList: editor?.isActive("bulletList"),
      orderedList: editor?.isActive("orderedList"),
      taskList: editor?.isActive("taskList"),
      blockquote: editor?.isActive("blockquote"),
      codeBlock: editor?.isActive("codeBlock"),
      link: editor?.isActive("link"),
      level: editor?.isActive("heading") ? String(editor.getAttributes("heading").level) : "0",
      undo: editor?.can().undo() ?? false,
      redo: editor?.can().redo() ?? false,
    }),
  });
  const tools = [
    {
      label: "粗体",
      Icon: Bold,
      active: active?.bold,
      run: () => editor?.chain().focus().toggleBold().run(),
    },
    {
      label: "斜体",
      Icon: Italic,
      active: active?.italic,
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: "删除线",
      Icon: Strikethrough,
      active: active?.strike,
      run: () => editor?.chain().focus().toggleStrike().run(),
    },
    {
      label: "无序列表",
      Icon: List,
      active: active?.bulletList,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: "有序列表",
      Icon: ListOrdered,
      active: active?.orderedList,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      label: "待办列表",
      Icon: ListTodo,
      active: active?.taskList,
      run: () => editor?.chain().focus().toggleTaskList().run(),
    },
    {
      label: "引用",
      Icon: Quote,
      active: active?.blockquote,
      run: () => editor?.chain().focus().toggleBlockquote().run(),
    },
    {
      label: "代码块",
      Icon: CodeSquare,
      active: active?.codeBlock,
      run: () => editor?.chain().focus().toggleCodeBlock().run(),
    },
    {
      label: "链接",
      Icon: Link2,
      active: active?.link,
      run: () => {
        setUrl(String(editor?.getAttributes("link").href ?? ""));
        setLinkError("");
        setLinkOpen(true);
      },
    },
  ];
  return (
    <section className="memo-editor" aria-label="编辑备忘录">
      <div className="editor-topline">
        <span>
          备忘录 <span className="muted-slash">/</span> 自由记录
        </span>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className={memo.pinned ? "text-primary bg-accent" : ""}
            aria-label={memo.pinned ? "取消置顶" : "置顶备忘录"}
            title={memo.pinned ? "取消置顶" : "置顶"}
            aria-pressed={memo.pinned}
            disabled={state.busy}
            onClick={() => state.editMemo(memo.id, { pinned: !memo.pinned })}
          >
            <Pin />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="移至回收站"
            title="移至回收站"
            disabled={state.busy}
            onClick={() => void state.deleteMemo(memo.id)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="editor-heading">
        <input
          className="memo-title"
          aria-label="备忘录标题"
          placeholder="无标题"
          value={memo.title}
          disabled={state.busy}
          onChange={(event) => state.editMemo(memo.id, { title: event.target.value })}
        />
        <TagInput
          tags={memo.tags}
          suggestions={knownTags(state.memos)}
          disabled={state.busy}
          onChange={(tags) => state.editMemo(memo.id, { tags })}
        />
      </div>
      <div className="editor-toolbar" role="toolbar" aria-label="文本格式">
        <select
          aria-label="标题级别"
          value={active?.level ?? "0"}
          disabled={state.busy}
          onChange={(event) => {
            const level = Number(event.target.value);
            if (level === 0) editor?.chain().focus().setParagraph().run();
            else
              editor
                ?.chain()
                .focus()
                .setHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 })
                .run();
          }}
        >
          <option value="0">正文</option>
          {[1, 2, 3, 4, 5, 6].map((level) => (
            <option value={level} key={level}>
              标题 {level}
            </option>
          ))}
        </select>
        <span className="toolbar-divider" />
        {tools.map(({ label, Icon, active, run }) => (
          <Button
            key={label}
            size="icon"
            variant="ghost"
            aria-label={label}
            title={label}
            aria-pressed={Boolean(active)}
            className={cn(active && "bg-accent text-primary")}
            disabled={state.busy || !editor}
            onMouseDown={(event) => event.preventDefault()}
            onClick={run}
          >
            <Icon />
          </Button>
        ))}
        <span className="toolbar-divider" />
        <Button
          size="icon"
          variant="ghost"
          aria-label="撤销"
          title="撤销"
          disabled={state.busy || !active?.undo}
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="重做"
          title="重做"
          disabled={state.busy || !active?.redo}
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Redo2 />
        </Button>
      </div>
      {notice && (
        <p className="editor-notice" role="status">
          {notice}
        </p>
      )}
      <div className="editor-scroll" aria-disabled={state.busy} inert={state.busy}>
        <EditorContent editor={editor} />
      </div>
      <div
        className={cn("editor-footer", state.saveStatus === "error" && "text-destructive")}
        role="status"
        aria-live="polite"
      >
        {state.saveStatus === "saved" ? (
          <Check size={14} />
        ) : state.saveStatus === "error" ? (
          <CircleAlert size={14} />
        ) : (
          <LoaderCircle size={14} className={state.saveStatus === "saving" ? "animate-spin" : ""} />
        )}
        <span>
          {
            {
              saved: "所有修改已保存",
              pending: "等待保存…",
              saving: "正在保存…",
              error: "保存失败，草稿仍在当前窗口。",
            }[state.saveStatus]
          }
        </span>
        {state.saveStatus === "error" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void workspace.flush().catch(() => undefined)}
          >
            重试保存
          </Button>
        )}
      </div>
      <Dialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        title="编辑链接"
        description="输入网页或邮箱链接，或清空地址以移除链接。"
        footer={
          <>
            <Button variant="outline" onClick={() => setLinkOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => {
                const href = url.trim();
                if (!editor || !applyMemoLink(editor, href)) {
                  setLinkError("请输入 http://、https:// 或 mailto: 开头的链接。");
                  return;
                }
                setLinkOpen(false);
              }}
            >
              应用链接
            </Button>
          </>
        }
      >
        <label className="mt-5 block text-xs text-muted-foreground" htmlFor="memo-link">
          链接地址
        </label>
        <input
          id="memo-link"
          className="text-input mt-2 w-full"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com"
        />
        {linkError && (
          <p className="mt-2 text-xs text-destructive" role="alert">
            {linkError}
          </p>
        )}
      </Dialog>
    </section>
  );
}
