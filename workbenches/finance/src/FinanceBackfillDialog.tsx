import { Button, Dialog } from "@workbench/ui";
import { useState } from "react";
import { financeApi, useFinanceState } from "./api";

export function FinanceBackfillDialog() {
  const open = useFinanceState((state) => state.confirmBackfill);
  const error = useFinanceState((state) => state.error);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) financeApi.dismissBackfill();
      }}
      title="开始首次回补？"
      description="需要下载个股 2015 年至今、指数估值 2005 年至今的数据，约 6000–8700 次请求，预计 35–50 分钟。期间可以正常使用，关掉 App 下次会继续。"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={financeApi.dismissBackfill}>
            稍后
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await financeApi.approveBackfill();
              } finally {
                setBusy(false);
              }
            }}
          >
            开始
          </Button>
        </>
      }
    >
      {error && (
        <p className="mt-3 text-destructive" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
