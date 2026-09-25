/**
 * Prompt-enhancement settings (ADR 0121).
 *
 * The ✨ Enhance action is a one-shot draft rewriter, entirely separate from the
 * agent's persona: it never becomes a conversation's system prompt. What is
 * configurable here is only which model runs the rewrite and with how much
 * reasoning. The rewrite instructions themselves are the product's, so there is
 * nothing to keep in sync and nothing to conflict with the persona.
 */
import { useTranslation } from "react-i18next";
import { SettingsCard } from "./primitives";
import { EnhancementModelCard } from "../../components/settings/EnhancementModelCard";

export function PromptEnhancementCard() {
  const { t } = useTranslation();
  return (
    <SettingsCard
      title={t("settings.promptEnhancementTitle")}
      description={t("settings.promptEnhancementDesc")}
    >
      <EnhancementModelCard />
    </SettingsCard>
  );
}
