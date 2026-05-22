import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import QuotaRulesManager from "./QuotaRulesManager";

function QuotaFallback() {
  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <CardSkeleton />
      <CardSkeleton />
    </div>
  );
}

export default function QuotaPage() {
  return (
    <Suspense fallback={<QuotaFallback />}>
      <div className="flex min-w-0 flex-col gap-7 px-1 sm:px-0">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-text-main">Quota</h1>
          <p className="mt-1 text-sm text-text-muted">
            Manage enforced runtime limits and current counted usage.
          </p>
        </div>

        <QuotaRulesManager />
      </div>
    </Suspense>
  );
}
