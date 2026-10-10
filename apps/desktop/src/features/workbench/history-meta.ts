/**
 * How a history row names the binding that ran.
 *
 * A recorded entry carries the provider beside the model, because the same
 * model id is served by more than one provider and a row that named only the
 * model would be ambiguous once the app restarts. An entry an earlier build
 * wrote carries no provider, and neither does a run that failed before one was
 * resolved: both fall back to the model alone rather than inventing a name.
 */

/** `provider/model` when the provider is known, the bare model id otherwise. */
export function historyModelLabel(
  model: { providerId: string; modelId: string } | null,
): string | undefined {
  if (!model) return undefined;
  return model.providerId ? `${model.providerId}/${model.modelId}` : model.modelId;
}
