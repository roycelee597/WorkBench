// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import { applyMemoLink, createMarkdownEditor, isSafeLink, markdownSummary } from "../src/markdown";

const fixtures = [
  {
    name: "六级标题",
    source: "# 一级\n\n## 二级\n\n### 三级\n\n#### 四级\n\n##### 五级\n\n###### 六级",
    type: "heading",
  },
  { name: "粗体", source: "这段有 **粗体文字**。", mark: "bold" },
  { name: "斜体", source: "这段有 *斜体文字*。", mark: "italic" },
  { name: "删除线", source: "这段有 ~~删除文字~~。", mark: "strike" },
  { name: "有序列表", source: "3. 第三项\n4. 第四项", type: "orderedList" },
  { name: "无序嵌套列表", source: "- 第一项\n  - 子项目\n- 第二项", type: "bulletList" },
  {
    name: "待办勾选与嵌套",
    source: "- [ ] 未完成\n  - [x] 子任务\n- [x] 已完成",
    type: "taskList",
  },
  { name: "引用", source: "> 引用第一段\n>\n> 第二段 **粗体**", type: "blockquote" },
  {
    name: "带语言的代码块",
    source: '```typescript\nconst my_value = "**原样保留**";\nconsole.log(my_value);\n```',
    type: "codeBlock",
  },
  {
    name: "链接与组合格式",
    source: "[**文档链接**](https://example.com/docs?q=1#start) 与 ***组合强调***",
    mark: "link",
  },
  {
    name: "转义符、空行与中文",
    source: "保留\\*星号\\*和 my_variable。\n\n第二段 `inline_code`。",
    mark: "code",
  },
];
function descendants(node: JSONContent): JSONContent[] {
  return [node, ...(node.content ?? []).flatMap(descendants)];
}

describe("编辑器 Markdown 往返", () => {
  it("没有选中文字时，链接入口插入可见 URL", () => {
    const editor = createMarkdownEditor("");
    try {
      expect(applyMemoLink(editor, " https://example.com/new ")).toBe(true);
      expect(editor.getText()).toBe("https://example.com/new");
      expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toEqual([
        expect.objectContaining({
          type: "link",
          attrs: expect.objectContaining({ href: "https://example.com/new" }),
        }),
      ]);
    } finally {
      editor.destroy();
    }
  });
  it("选中文本添加链接，光标在链接内时可改地址和移除，文字保留", () => {
    const editor = createMarkdownEditor("文字");
    try {
      editor.commands.setTextSelection({ from: 1, to: 3 });
      expect(applyMemoLink(editor, "https://example.com/one")).toBe(true);
      editor.commands.setTextSelection(2);
      applyMemoLink(editor, "https://example.com/two");
      expect(editor.getMarkdown()).toContain("https://example.com/two");
      editor.commands.setTextSelection(2);
      applyMemoLink(editor, "");
      expect(editor.getText()).toBe("文字");
      expect(editor.getJSON().content?.[0]?.content?.[0]?.marks).toBeUndefined();
    } finally {
      editor.destroy();
    }
  });
  it("非法地址不会改变已编辑的正文", () => {
    const editor = createMarkdownEditor("**保留原文**");
    try {
      const before = editor.getJSON();
      expect(applyMemoLink(editor, "javascript:alert(1)")).toBe(false);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });
  it.each(fixtures)("$name 的节点、标记与文字不丢失", ({ source, type, mark }) => {
    const first = createMarkdownEditor(source);
    const original = first.getJSON();
    const stored = first.getMarkdown();
    const second = createMarkdownEditor(stored);
    const third = createMarkdownEditor(second.getMarkdown());
    try {
      expect(second.getJSON()).toEqual(original);
      expect(third.getJSON()).toEqual(original);
      const nodes = descendants(original);
      if (type) expect(nodes.some((node) => node.type === type)).toBe(true);
      if (mark)
        expect(nodes.some((node) => node.marks?.some((item) => item.type === mark))).toBe(true);
      if (type === "taskList")
        expect(
          nodes.filter((node) => node.type === "taskItem").map((node) => node.attrs?.checked),
        ).toEqual([false, true, true]);
      if (type === "orderedList")
        expect(nodes.find((node) => node.type === type)?.attrs?.start).toBe(3);
      if (type === "codeBlock")
        expect(nodes.find((node) => node.type === type)).toMatchObject({
          attrs: { language: "typescript" },
          content: [
            { type: "text", text: 'const my_value = "**原样保留**";\nconsole.log(my_value);' },
          ],
        });
      if (mark === "link")
        expect(
          nodes.flatMap((node) => node.marks ?? []).find((item) => item.type === "link")?.attrs
            ?.href,
        ).toBe("https://example.com/docs?q=1#start");
    } finally {
      first.destroy();
      second.destroy();
      third.destroy();
    }
  });
  it("空正文与文本摘要不改变文字中的下划线", () => {
    const editor = createMarkdownEditor("");
    try {
      expect(editor.getMarkdown()).toBe("");
    } finally {
      editor.destroy();
    }
    expect(markdownSummary("## **想法**\n\n`my_variable` 与 \\*星号\\*")).toBe(
      "想法\nmy_variable 与 *星号*",
    );
  });
  it("只允许网页、邮箱链接，编辑器不支持图片与可执行链接", () => {
    expect(isSafeLink("https://example.com")).toBe(true);
    expect(isSafeLink("mailto:hello@example.com")).toBe(true);
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///C:/x", "bad"])
      expect(isSafeLink(url)).toBe(false);
    const editor = createMarkdownEditor(
      "[危险](javascript:alert%281%29)\n\n![图片](https://example.com/a.png)",
    );
    try {
      expect(editor.getHTML()).not.toContain("javascript:");
      expect(editor.getHTML()).not.toContain("<img");
    } finally {
      editor.destroy();
    }
  });
});
