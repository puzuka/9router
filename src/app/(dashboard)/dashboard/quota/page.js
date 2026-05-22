import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";

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
          <h1 className="text-2xl font-semibold text-text-main">Quota Tracker</h1>
          <p className="mt-1 text-sm text-text-muted">
            Track provider account quotas, reset windows, and remaining usage.
          </p>
        </div>

        <ProviderLimits />
      </div>
    </Suspense>
  );
}
