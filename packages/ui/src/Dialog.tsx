import { useRef, type ReactNode } from "react";
import * as Primitive from "@radix-ui/react-dialog";
import { Button } from "./Button";

// shadcn/ui 的 Radix 对话框结构：焦点圈定、Esc 关闭、关闭后还原焦点。
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const previousFocus = useRef<HTMLElement | null>(null);
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px]" />
        <Primitive.Content
          onOpenAutoFocus={() => {
            previousFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100%-40px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-6 shadow-xl focus:outline-none"
        >
          <Primitive.Title className="text-lg font-semibold tracking-tight">
            {title}
          </Primitive.Title>
          <Primitive.Description className="mt-2 text-sm leading-6 text-muted-foreground">
            {description}
          </Primitive.Description>
          {children}
          <div className="mt-6 flex justify-end gap-2">
            {footer ?? (
              <Primitive.Close asChild>
                <Button variant="outline">关闭</Button>
              </Primitive.Close>
            )}
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
