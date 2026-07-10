"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlanDetailsForm, type PlanDetailsFormValues } from "../../../../../components/plans/PlanDetailsForm.js";
import { PlanReviewSubmit } from "../../../../../components/plans/PlanReviewSubmit.js";

type WizardScreen = { step: "details" } | { step: "review"; values: PlanDetailsFormValues };

export default function NewPlanPage() {
  const router = useRouter();
  const [screen, setScreen] = useState<WizardScreen>({ step: "details" });

  return (
    <div>
      <h1 className="font-display text-2xl mb-6">New Plan</h1>
      {screen.step === "details" && (
        <PlanDetailsForm onContinue={(values) => setScreen({ step: "review", values })} />
      )}
      {screen.step === "review" && (
        <PlanReviewSubmit values={screen.values} onDone={() => router.push("/dashboard/plans")} />
      )}
    </div>
  );
}
