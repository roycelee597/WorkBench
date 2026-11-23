import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@workbench/ui";
import { connectFinanceModule } from "./api";
import { FinanceBackfillDialog } from "./FinanceBackfillDialog";
import { FinanceSettings } from "./FinanceSettings";
import { FinanceWorkbench } from "./FinanceWorkbench";
import "./finance.css";

function FinanceModule() {
  const [settings, setSettings] = useState(
    () => new URLSearchParams(window.location.hash.slice(1)).get("view") === "settings",
  );
  return (
    <>
      {settings ? (
        <main className="mx-auto max-w-4xl space-y-4 p-6">
          <Button variant="outline" size="sm" onClick={() => setSettings(false)}>
            返回金融指标
          </Button>
          <FinanceSettings />
        </main>
      ) : (
        <FinanceWorkbench openSettings={() => setSettings(true)} />
      )}
      <FinanceBackfillDialog />
    </>
  );
}

const stop = connectFinanceModule();
window.addEventListener("pagehide", stop, { once: true });
createRoot(document.getElementById("root")!).render(<FinanceModule />);
