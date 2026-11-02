import type { Mode } from "@pi-desktop/shared";
import { IconListChecks, IconSparkles, IconTarget } from "../../../components/icons";

export function ModeIcon({ mode }: { mode: Mode }) {
  // The size rides a CSS variable so the phone toolbar can normalise the painted
  // ink across icons while the desktop keeps its own box. Defaults to 16px.
  const size = "var(--composer-glyph, 16px)";
  if (mode === "plan") return <IconListChecks size={size} />;
  if (mode === "goal") return <IconTarget size={size} />;
  return <IconSparkles size={size} />;
}
