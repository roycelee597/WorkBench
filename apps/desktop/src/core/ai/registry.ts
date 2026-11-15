import type { AiActionGroup, RegisteredAction } from "./action-types";
import { llmRequestSchema, type LlmRequest } from "./llm-client";

function copyAction(action: RegisteredAction): RegisteredAction {
  return { ...action, parameters: structuredClone(action.parameters) };
}

export class AiRegistry {
  private readonly actions = new Map<string, RegisteredAction>();
  private readonly registeredGroups: AiActionGroup[] = [];

  register(group: AiActionGroup): void {
    if (!group.workbenchId.trim() || !group.label.trim())
      throw new Error("AI 操作登记缺少工作台或分组名称");
    const names = new Set<string>();
    for (const action of group.actions) {
      if (!/^[a-z]+_[a-z_]+$/.test(action.name) || action.name.length > 64)
        throw new Error("AI 操作名称格式无效");
      if (this.actions.has(action.name) || names.has(action.name))
        throw new Error(`AI 操作名称重复：${action.name}`);
      names.add(action.name);
      if (action.workbenchId !== group.workbenchId) throw new Error("AI 操作与登记工作台不一致");
      if (action.kind !== "read" && action.kind !== "write") throw new Error("AI 操作类型无效");
      if (!action.description.trim() || action.description.length > 300)
        throw new Error("AI 操作说明应为 1–300 字");
      if (typeof action.prepare !== "function" || typeof action.args?.safeParse !== "function")
        throw new Error("AI 操作缺少参数校验或草稿解析方法");
      if (
        action.kind === "write" &&
        (!action.Preview ||
          typeof action.validate !== "function" ||
          typeof action.execute !== "function")
      )
        throw new Error("AI 写入操作必须提供 Preview、validate 和 execute");
      if (action.kind === "read" && action.execute !== undefined)
        throw new Error("AI 读取操作不能提供 execute");
    }
    // 先校验整批及总数再提交，失败时不留下部分登记的操作。
    const combined = [...this.actions.values(), ...group.actions];
    llmRequestSchema.shape.tools.parse(
      combined.map((action) => ({
        type: "function" as const,
        function: {
          name: action.name,
          description: action.description,
          parameters: action.parameters,
        },
      })),
    );
    const stored = { ...group, actions: group.actions.map(copyAction) };
    for (const action of stored.actions) this.actions.set(action.name, action);
    this.registeredGroups.push(stored);
  }

  get(name: string): RegisteredAction | undefined {
    const action = this.actions.get(name);
    return action ? copyAction(action) : undefined;
  }

  tools({ allowRead = true }: { allowRead?: boolean } = {}): LlmRequest["tools"] {
    return [...this.actions.values()]
      .filter((action) => allowRead || action.kind !== "read")
      .map((action) => ({
        type: "function",
        function: {
          name: action.name,
          description: action.description,
          parameters: structuredClone(action.parameters),
        },
      }));
  }

  groups(): AiActionGroup[] {
    return this.registeredGroups.map((group) => ({
      ...group,
      actions: group.actions.map(copyAction),
    }));
  }
}

// A2 的正式登记表保持为空；测试在各自实例中登记假操作。
export const aiRegistry = new AiRegistry();
