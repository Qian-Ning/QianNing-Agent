/**
 * How a failed or cancelled library entry reads in the workbench history.
 *
 * The main process records an `errorCode` on every run that produced no file, so
 * the history row can say *why* a render is not there instead of leaving a blank
 * line. This maps the codes the media pipeline can emit onto localized copy.
 *
 * Precedence, so wording never drifts into two copies:
 *   1. `errors.<code>` — a provider or network refusal already has a sentence
 *      the rest of the app shows, and it must be the same sentence here.
 *   2. The media table below — the codes only the generation pipeline emits.
 *   3. A generic line — an unknown code (a new provider, a future failure kind)
 *      still reads as a failure rather than the raw key, which is what a blank
 *      row would otherwise become.
 */
import type { TFunction } from "i18next";

/**
 * Media-pipeline codes with a dedicated line under `workbench.*`. The provider
 * and network family is deliberately absent: those keys live under `errors.*`
 * and are tried first. Exported so a test can prove every value names a real
 * catalog key rather than a typo that would render as the key string.
 */
export const LIBRARY_ERROR_KEYS: Record<string, string> = {
  IMAGE_CANCELLED: "workbench.libraryErrorCancelled",
  VIDEO_CANCELLED: "workbench.libraryErrorCancelled",
  IMAGE_TIMEOUT: "workbench.libraryErrorTimeout",
  VIDEO_TIMEOUT: "workbench.libraryErrorTimeout",
  IMAGE_NOT_CONFIGURED: "workbench.libraryErrorNotConfigured",
  VIDEO_NOT_CONFIGURED: "workbench.libraryErrorNotConfigured",
  IMAGE_MODEL_UNAVAILABLE: "workbench.libraryErrorModelUnavailable",
  VIDEO_MODEL_UNAVAILABLE: "workbench.libraryErrorModelUnavailable",
  IMAGE_AUTH_UNSUPPORTED: "workbench.libraryErrorAuthUnsupported",
  VIDEO_AUTH_UNSUPPORTED: "workbench.libraryErrorAuthUnsupported",
  IMAGE_AUTH_FAILED: "workbench.libraryErrorAuthFailed",
  VIDEO_AUTH_FAILED: "workbench.libraryErrorAuthFailed",
  INVALID_ARGUMENT: "workbench.libraryErrorInvalidRequest",
  MEDIA_FAILED: "workbench.libraryErrorGeneric",
};

/**
 * The one sentence for a failed or cancelled entry.
 *
 * i18next returns the key itself when a catalog has no entry for it, so a
 * resolved string that still equals the key means "no translation here" — the
 * echo check the provider test result uses. Never returns an empty string.
 */
export function describeLibraryError(errorCode: string | undefined, t: TFunction): string {
  if (errorCode) {
    const providerKey = `errors.${errorCode}`;
    const providerCopy = t(providerKey);
    if (providerCopy !== providerKey) return providerCopy;
    const known = LIBRARY_ERROR_KEYS[errorCode];
    if (known) return t(known);
  }
  return t("workbench.libraryErrorGeneric");
}
