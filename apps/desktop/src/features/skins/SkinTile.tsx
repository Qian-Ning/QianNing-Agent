import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Skin } from "@pi-desktop/shared";
import { cx } from "../../components/ui";
import { IconCheck, IconCopy, IconDownload, IconImage, IconMore, IconPencil, IconTrash } from "../../components/icons";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import { SkinPreview } from "./SkinPreview";

export type SkinTileActions = {
  onEdit?: () => void;
  /** Replace the wallpaper behind an existing skin, keeping its palette. */
  onChangeWallpaper?: () => void;
  onDuplicate?: () => void;
  onExport?: () => void;
  onRemove?: () => void;
};

type Props = {
  skin: Skin;
  label: string;
  active: boolean;
  onApply: () => void;
  actions: SkinTileActions;
};

/**
 * One tile in the swap rail: a bare preview, a name, and a menu.
 *
 * The previous card carried four always-visible icon buttons under every
 * thumbnail, which is why the page read as a control panel instead of a
 * gallery. Here the tile is a picture; its verbs live behind the ⋯ so the wall
 * stays quiet, and the whole picture is the apply target.
 */
export function SkinTile({ skin, label, active, onApply, actions }: Props) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);

  const items = [
    actions.onEdit ? { key: "edit", label: t("skins.edit"), icon: <IconPencil size={14} />, run: actions.onEdit } : null,
    actions.onChangeWallpaper
      ? {
          key: "wallpaper",
          label: t("skins.changeWallpaper"),
          icon: <IconImage size={14} />,
          run: actions.onChangeWallpaper,
        }
      : null,
    actions.onDuplicate
      ? { key: "duplicate", label: t("skins.duplicate"), icon: <IconCopy size={14} />, run: actions.onDuplicate }
      : null,
    actions.onExport ? { key: "export", label: t("skins.export"), icon: <IconDownload size={14} />, run: actions.onExport } : null,
    actions.onRemove
      ? { key: "remove", label: t("skins.delete"), icon: <IconTrash size={14} />, run: actions.onRemove, danger: true }
      : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <div className={cx("sk-tile", active && "is-active")}>
      <button
        type="button"
        className="sk-tile-hit"
        onClick={onApply}
        aria-pressed={active}
        aria-label={t("skins.applyNamed", { name: label })}
      >
        <SkinPreview skin={skin} variant="tile" />
        {active ? (
          <span className="sk-tile-check" aria-hidden>
            <IconCheck size={11} />
          </span>
        ) : null}
      </button>

      <div className="sk-tile-foot">
        <span className="sk-tile-name" title={label}>
          {label}
        </span>
        {items.length > 0 ? (
          <AnchoredMenu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            menuClassName="sk-tile-menu"
            label={label}
            role="menu"
            align="end"
            className="sk-tile-menu-anchor"
            trigger={(ref) => (
              <button
                ref={ref}
                type="button"
                className="sk-tile-more"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={t("skins.moreActions", { name: label })}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <IconMore size={14} />
              </button>
            )}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={cx("sk-menu-item", item.danger && "is-danger")}
                onClick={() => {
                  setMenuOpen(false);
                  item.run();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </AnchoredMenu>
        ) : null}
      </div>
    </div>
  );
}
