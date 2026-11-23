import { useState } from "react";
import { useStore } from "zustand";
import { Button, Dialog } from "@workbench/ui";
import { financeOperations, financeState, financeWrite } from "../core/finance/finance-host";

export function FinanceStartupPrompt() {
  const open = useStore(financeState, (state) => state.confirmBackfill);
  const error = useStore(financeState, (state) => state.error);
  const [working, setWorking] = useState(false);
  const dismiss = financeOperations.dismissBackfill;

  async function approve() {
    setWorking(true);
    try {
      await financeWrite(financeOperations.approveBackfill);
    } catch {
      // 模块已在清理，入口随目录状态一并关闭。
      dismiss();
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !working) dismiss();
      }}
      title="开始首次回补？"
      description="需要下载个股 2015 年至今、指数估值 2005 年至今的数据，约 6000–8700 次请求，预计 35–50 分钟。期间可以正常使用，关掉 App 下次会继续。"
      footer={
        <>
          <Button variant="outline" disabled={working} onClick={dismiss}>
            稍后
          </Button>
          <Button disabled={working} onClick={() => void approve()}>
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
