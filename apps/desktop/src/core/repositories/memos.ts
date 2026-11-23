import type { SqlDatabase } from "../db/database";
import { BaseRepository } from "./base-repository";
import type { Memo, MemoFields, RepositoryContext } from "./models";
import { memoDefinition } from "./record-codecs";

export class MemosRepository extends BaseRepository<Memo, MemoFields> {
  constructor(db: SqlDatabase, context: RepositoryContext) {
    super(db, context, memoDefinition);
  }
  create(input: Partial<MemoFields> = {}): Promise<Memo> {
    const fields = { title: "", content: "", pinned: false, tags: [], ...input };
    this.validate(fields);
    return this.insert(fields);
  }
  createForModule(moduleId: string, input: Partial<MemoFields>): Promise<Memo> {
    const fields = {
      title: "",
      content: "",
      pinned: false,
      tags: [],
      ...input,
      source_workbench: moduleId,
    };
    this.validate(fields);
    return this.insert(fields);
  }
  async updateForModule(
    moduleId: string,
    id: string,
    patch: Partial<MemoFields>,
  ): Promise<Memo | null> {
    const memo = (
      await this.read(
        "id = ? AND source_workbench = ? AND deleted_at IS NULL AND purged_at IS NULL",
        [id, moduleId],
      )
    )[0];
    if (!memo) return null;
    this.validate({ ...memo, ...patch });
    return this.writePatch(id, patch);
  }
  async update(id: string, patch: Partial<MemoFields>): Promise<Memo> {
    const current = await this.requireActive(id);
    this.validate({ ...current, ...patch });
    return this.writePatch(id, patch);
  }
  private validate(fields: MemoFields): void {
    if (
      typeof fields.title !== "string" ||
      typeof fields.content !== "string" ||
      typeof fields.pinned !== "boolean" ||
      !Array.isArray(fields.tags) ||
      !fields.tags.every((tag) => typeof tag === "string")
    )
      throw new Error("便笺字段无效");
  }
}
