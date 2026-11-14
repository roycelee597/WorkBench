import { Button } from "@workbench/ui";
import type { OrchestratorEvent } from "../../../../apps/desktop/src/core/ai/orchestrator";

export function ErrorCard({
  error,
  openSettings,
  manualCreate,
  openPlatform,
}: {
  error: Extract<OrchestratorEvent, { type: "error" }>;
  openSettings: () => void;
  manualCreate: () => void;
  openPlatform: () => void;
}) {
  return (
    <div className="ai-error-card" role="alert">
      <strong>这次没有完成</strong>
      <p>{error.message}</p>
      <div className="flex flex-wrap gap-2">
        {(error.fallback === "settings" ||
          error.code === "KEY_INVALID" ||
          error.code === "KEY_MISSING") && (
          <Button variant="outline" size="sm" onClick={openSettings}>
            去设置
          </Button>
        )}
        {error.code === "INSUFFICIENT_BALANCE" && (
          <Button variant="outline" size="sm" onClick={openPlatform}>
            DeepSeek 开放平台
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={manualCreate}>
          手动新建
        </Button>
      </div>
    </div>
  );
}
