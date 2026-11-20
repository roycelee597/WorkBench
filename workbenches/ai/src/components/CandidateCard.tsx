import { Button } from "@workbench/ui";
import type { AiStore } from "../ai-store";
import { ProposalCard } from "./ProposalCard";

export function CandidateCard({ id, store }: { id: string; store: AiStore }) {
  const choice = store((state) => state.choices[id]);
  const proposal = store((state) => state.proposals[id]);
  if (proposal) return <ProposalCard id={id} store={store} />;
  if (!choice) return <p className="ai-message-note">此操作无法继续，请重新说明。</p>;
  return (
    <section className="space-y-3 rounded-xl border border-border p-4" aria-label="选择操作目标">
      <h2 className="font-semibold">{choice.prepared.prompt}</h2>
      {choice.status === "expired" ? (
        <p>已失效</p>
      ) : (
        <div className="flex flex-col items-start gap-2">
          {choice.prepared.candidates.map((candidate) => (
            <Button
              key={candidate.id}
              variant="outline"
              disabled={choice.status !== "pending"}
              onClick={() => void store.getState().pickCandidate(id, candidate.id)}
            >
              {candidate.when} · {candidate.title}
              {candidate.detail ? ` · ${candidate.detail}` : ""}
            </Button>
          ))}
        </div>
      )}
      {choice.status === "choosing" && <p role="status">正在核对所选目标…</p>}
      {choice.errors.map((error, index) => (
        <p key={index} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ))}
      {choice.target && (
        <Button
          variant="outline"
          onClick={() => void store.getState().openLocalTarget(choice.target!, id)}
        >
          {choice.target.kind === "event" ? "在日程中打开" : "在提醒中打开"}
        </Button>
      )}
    </section>
  );
}
