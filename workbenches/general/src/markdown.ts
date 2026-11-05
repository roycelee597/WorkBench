import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown, MarkdownManager } from "@tiptap/markdown";

export function isSafeLink(value: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// 编辑器与往返测试共用扩展，避免测试模型与实际界面不一致。
export function memoExtensions() {
  return [
    StarterKit.configure({
      underline: false,
      link: { openOnClick: false, defaultProtocol: "https", isAllowedUri: isSafeLink },
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
      a11y: { checkboxLabel: (node) => `待办事项：${node.textContent || "未命名待办"}` },
    }),
    Placeholder.configure({ placeholder: "从一个想法开始…" }),
    Markdown.configure({ markedOptions: { gfm: true } }),
  ];
}

export function createMarkdownEditor(content: string) {
  return new Editor({
    extensions: memoExtensions(),
    content,
    contentType: "markdown",
    injectCSS: false,
  });
}

export function applyMemoLink(editor: Editor, value: string): boolean {
  const href = value.trim();
  if (href && !isSafeLink(href)) return false;
  if (href && editor.state.selection.empty && !editor.isActive("link")) {
    return editor
      .chain()
      .focus()
      .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
      .run();
  }
  const chain = editor.chain().focus().extendMarkRange("link");
  return href ? chain.setLink({ href }).run() : chain.unsetLink().run();
}

export function textFromDocument(document: JSONContent): string {
  if (document.type === "text") return document.text ?? "";
  if (document.type === "hardBreak") return "\n";
  const children = document.content ?? [];
  return children
    .map(textFromDocument)
    .join(
      [
        "doc",
        "bulletList",
        "orderedList",
        "taskList",
        "listItem",
        "taskItem",
        "blockquote",
      ].includes(document.type ?? "")
        ? "\n"
        : "",
    );
}

// 摘要只解析语法，不创建 DOM 编辑器，也不渲染外部 HTML。
const summaryParser = new MarkdownManager({
  extensions: memoExtensions(),
  markedOptions: { gfm: true },
});
const summaries = new Map<string, string>();
export function markdownSummary(content: string): string {
  const cached = summaries.get(content);
  if (cached !== undefined) return cached;
  const result = textFromDocument(summaryParser.parse(content)).trim();
  if (summaries.size >= 200) summaries.delete(summaries.keys().next().value!);
  summaries.set(content, result);
  return result;
}
