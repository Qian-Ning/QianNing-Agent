/**
 * How a provider connection test reads to the user.
 *
 * Shared by the two settings surfaces that run the test — the model
 * configuration page and the provider setup dialog — so the pass wording and
 * every failure wording stay one rule instead of two copies that drift.
 *
 * A coded failure prefers the localized string for its code over the main
 * process's free text: the code is the part that is certain, and it is what
 * carries the explanation ("an edge blocked this, not your key"). The echo
 * check mirrors the transcript's, because i18next returns the key itself when a
 * catalog has no entry for it.
 */

import type { TFunction } from "i18next";

export type ProviderTestResult = {
  ok?: boolean;
  message?: string;
  status?: number;
  errorCode?: string;
  /** Intermediary that refused, when the failure came from a block page. */
  edge?: string;
};

export function describeProviderTestResult(
  result: ProviderTestResult | undefined,
  t: TFunction,
): string {
  if (result?.ok) return t("settings.testOk");
  if (result?.errorCode) {
    const key = `errors.${result.errorCode}`;
    const localized = t(key);
    if (localized !== key) return localized;
  }
  if (result?.message) return result.message;
  return result?.status
    ? t("settings.testFailedStatus", { status: result.status })
    : t("settings.testFailed");
}
