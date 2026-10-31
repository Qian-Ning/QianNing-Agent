import type { Ref } from "react";
import type { TFunction } from "i18next";
import type { Mode } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { TooltipButton } from "../../../components/ui";
import { IconCheck } from "../../../components/icons";
import { ModeIcon } from "./ComposerModeIcon";
import { MODE_CYCLE, MODE_LABEL_KEYS, nextMode } from "./model";

/** The desktop keeps cycling; the phone exposes all choices in one menu. */
export function ComposerModePicker({ t, mode, planningLive, phoneSurface, open, setOpen, disabled, onCloseOtherMenus, onSelect }: {
  t: TFunction;
  mode: Mode;
  planningLive: boolean;
  phoneSurface: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  disabled: boolean;
  onCloseOtherMenus: () => void;
  onSelect: (mode: Mode) => Promise<void>;
}) {
  const label = planningLive ? t(`${mode}.planning`) : t("settings.mode");
  const trigger = (ref?: Ref<HTMLButtonElement>) => (
    <TooltipButton ref={ref} type="button" className="icon-btn mode-chip composer-mode-chip"
      data-mode={mode} data-planning={planningLive ? "true" : undefined}
      tooltip={label} ariaLabel={label} disabled={disabled}
      aria-haspopup={phoneSurface ? "menu" : undefined} aria-expanded={phoneSurface ? open : undefined}
      onClick={() => {
        onCloseOtherMenus();
        if (phoneSurface) setOpen(!open);
        else void onSelect(nextMode(mode));
      }}>
      <span className="composer-mode-chip-face" key={mode}>
        <ModeIcon mode={mode} />
        <span className="composer-mode-chip-label text-sm">{t(MODE_LABEL_KEYS[mode])}</span>
      </span>
    </TooltipButton>
  );
  if (!phoneSurface) return trigger();
  return <AnchoredMenu className="composer-mode-anchor" open={open} onClose={() => setOpen(false)}
    menuClassName="composer-permission-menu" label={t("settings.mode")} role="menu" align="start" side="top" trigger={trigger}>
    {MODE_CYCLE.map((candidate) => <button key={candidate} type="button" role="menuitemradio"
      data-mode-choice={candidate} aria-checked={mode === candidate} disabled={disabled}
      className={`composer-plus-item ${mode === candidate ? "active" : ""}`}
      onClick={() => { setOpen(false); void onSelect(candidate); }}>
      <ModeIcon mode={candidate} />
      <span className="flex-1 text-left">{t(MODE_LABEL_KEYS[candidate])}</span>
      {mode === candidate ? <IconCheck size={13} /> : null}
    </button>)}
  </AnchoredMenu>;
}