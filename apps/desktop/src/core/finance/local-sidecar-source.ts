import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  parseEngineEvent,
  type EngineEvent,
  type FinanceDone,
  type FinanceStage,
} from "./engine-events";
import {
  FinanceReader,
  type DateRange,
  type FinanceStatus,
  type FinancePoint,
  type IndicatorMeta,
  type SeriesData,
} from "./finance-reader";

export type UpdateMode = "auto" | "full-rebuild";
export interface FinanceDataSource {
  listIndicators(): Promise<IndicatorMeta[]>;
  getSeries(keys: string[], range?: DateRange): Promise<SeriesData[]>;
  getRecent(keys: string[]): Promise<SeriesData[]>;
  getOverlay(): Promise<FinancePoint[]>;
  getStatus(): Promise<FinanceStatus>;
  requestUpdate(mode?: UpdateMode): Promise<void>;
  onEvent(callback: (event: EngineEvent) => void): () => void;
}

type Snapshot = {
  status: "idle" | "running" | "complete" | "partial" | "failed" | "already_running";
  stage?: FinanceStage | undefined;
  progress?: Extract<EngineEvent, { type: "progress" }> | undefined;
  diagnostic?: { code: string; message: string } | undefined;
  revision: number;
};

type Bridge = {
  start(mode: UpdateMode): Promise<"started" | "already_running">;
  subscribe(callback: (payload: unknown) => void): Promise<() => void>;
};

const bridge: Bridge = {
  start: (mode) => invoke("finance_update_start", { mode }),
  subscribe: (callback) => listen("finance://event", (event) => callback(event.payload)),
};

export function financeDiagnostic(error: unknown): { code: string; message: string } {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "INTERNAL",
    message: error instanceof Error ? error.message : "金融操作未完成，请重试",
  };
}

export class LocalSidecarSource implements FinanceDataSource {
  private snapshot: Snapshot = { status: "idle", revision: 0 };
  private listeners = new Set<() => void>();
  private events = new Set<(event: EngineEvent) => void>();
  private connection: Promise<() => void> | undefined;
  private outcome: FinanceDone["status"] | undefined;
  private mode: UpdateMode = "auto";
  private exits = new Set<(mode: UpdateMode) => void>();

  constructor(
    private readonly reader = new FinanceReader(),
    private readonly port = bridge,
  ) {}

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  };

  onEvent(callback: (event: EngineEvent) => void): () => void {
    this.events.add(callback);
    void this.connect().catch(() => undefined);
    return () => this.events.delete(callback);
  }

  onExit(callback: (mode: UpdateMode) => void): () => void {
    this.exits.add(callback);
    return () => this.exits.delete(callback);
  }

  private set(update: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }

  connect(): Promise<() => void> {
    this.connection ??= this.port
      .subscribe((payload) => {
        const event = parseEngineEvent(payload);
        if (!event) {
          console.warn("已忽略格式无效的金融引擎事件");
          return;
        }
        this.receive(event);
        for (const callback of this.events) callback(event);
      })
      .catch((error: unknown) => {
        this.connection = undefined;
        throw error;
      });
    return this.connection;
  }

  private receive(event: EngineEvent): void {
    switch (event.type) {
      case "hello":
        this.outcome = undefined;
        if (this.snapshot.status !== "running" && this.snapshot.status !== "already_running") {
          this.set({ status: "running", diagnostic: undefined });
        }
        break;
      case "stage":
        // 引擎在 stock_basic 之前完成重建所需的缓存替换，之后可继续读取 WAL。
        if (event.stage === "stock_basic") this.reader.resume();
        this.set({ stage: event.stage, progress: undefined });
        break;
      case "progress":
        this.set({ stage: event.stage, progress: event });
        break;
      case "warning":
      case "error":
        this.set({ diagnostic: { code: event.code, message: event.message } });
        break;
      case "indicator_updated":
        this.set({ revision: this.snapshot.revision + 1 });
        break;
      case "done":
        this.outcome = event.status;
        break;
      case "engine_exit": {
        this.reader.resume();
        const status = event.cancelled
          ? "idle"
          : event.code === 0 && this.outcome === "ok"
            ? "complete"
            : event.code === 0 && this.outcome === "partial"
              ? "partial"
              : "failed";
        const mode = this.mode;
        this.outcome = undefined;
        this.mode = "auto";
        for (const callback of this.exits) callback(mode);
        this.set({
          status,
          stage: undefined,
          progress: undefined,
          diagnostic:
            status === "failed"
              ? (this.snapshot.diagnostic ?? { code: "ENGINE_EXIT", message: "金融引擎未正常完成" })
              : status === "idle"
                ? undefined
                : this.snapshot.diagnostic,
          revision: this.snapshot.revision + 1,
        });
        break;
      }
    }
  }

  listIndicators() {
    return this.reader.listIndicators();
  }
  getSeries(keys: string[], range?: DateRange) {
    return this.reader.getSeries(keys, range);
  }
  getStatus() {
    return this.reader.getStatus();
  }
  getRecent(keys: string[]) {
    return this.reader.getRecent(keys);
  }
  getOverlay() {
    return this.reader.getOverlay();
  }

  async requestUpdate(mode: UpdateMode = "auto"): Promise<void> {
    if (this.snapshot.status === "running" || this.snapshot.status === "already_running") return;
    this.outcome = undefined;
    this.mode = mode;
    this.set({ status: "running", stage: undefined, progress: undefined, diagnostic: undefined });
    try {
      await this.connect();
      if (mode === "full-rebuild") await this.reader.suspendForRebuild();
      const result = await this.port.start(mode);
      if (result === "already_running" && this.getSnapshot().status === "running") {
        this.mode = "auto";
        this.set({ status: "already_running" });
      }
    } catch (error) {
      this.mode = "auto";
      this.reader.resume();
      this.set({ status: "failed", diagnostic: financeDiagnostic(error) });
    }
  }
}
