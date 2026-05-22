import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import QuotaRulesManager from "../quota/QuotaRulesManager";

function QuotaRulesFallback() {
  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <CardSkeleton />
      <CardSkeleton />
    </div>
  );
}

export default function QuotaRulesPage() {
  return (
    <Suspense fallback={<QuotaRulesFallback />}>
      <div className="flex min-w-0 flex-col gap-7 px-1 sm:px-0">
        <QuotaRulesManager />
      </div>
    </Suspense>
  );
}
