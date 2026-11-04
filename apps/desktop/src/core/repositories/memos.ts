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
