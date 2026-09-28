import { useTranslation } from "react-i18next";
import { NO_SKIN_ID, skinBaseScheme, skinCssVariables, type Skin } from "@pi-desktop/shared";
import { skinAssetUrl } from "../../lib/skin-engine";
import { cx } from "../../components/ui";
import { IconCheck, IconImage, IconPencil, IconTrash, IconUpload, IconVideo } from "../../components/icons";

/**
 * One skin in the card wall: a miniature window preview painted with the skin's
 * own palette (and a background thumbnail for media skins), its name, a type
 * badge, and — for user skins — edit / export / delete affordances. Clicking the
 * card applies the skin; hovering previews it live via the page's handlers.
 */
export function SkinCard({
  skin,
  active,
  onApply,
  onPreviewStart,
  onPreviewEnd,
  onEdit,
  onExport,
  onDelete,
  typeLabel,
  editable = false,
}: {
  skin: Skin;
  active: boolean;
  onApply: () => void;
  onPreviewStart: () => void;
  onPreviewEnd: () => void;
  onEdit?: () => void;
  onExport?: () => void;
  onDelete?: () => void;
  typeLabel: string;
  editable?: boolean;
}) {
  const { t } = useTranslation();
  const vars = skinCssVariables(skin);
  const scheme = skinBaseScheme(skin.base);
  const isNone = skin.id === NO_SKIN_ID;
  // The preview swatch derives from the skin's own tokens, falling back to the
  // base-scheme defaults so a colours-light skin still looks like itself.
  const previewStyle: Record<string, string> = {
    ["--sk-bg" as string]: vars["--ds-bg-primary"] ?? (scheme === "light" ? "#f7f2ea" : "#0f1115"),
    ["--sk-panel" as string]: vars["--ds-bg-secondary"] ?? (scheme === "light" ? "#ffffff" : "#181b21"),
    ["--sk-accent" as string]: vars["--ds-accent"] ?? "#5b8def",
    ["--sk-fg" as string]: vars["--ds-text-primary"] ?? (scheme === "light" ? "#2c2620" : "#e6e8ee"),
  };
  const bgUrl =
    skin.background.kind !== "none" && skin.background.assetId && skin.background.ext
      ? skinAssetUrl(skin.background.assetId, skin.background.ext)
      : null;

  return (
    <div
      className={cx("skin-card", active && "is-active")}
      onMouseEnter={onPreviewStart}
      onMouseLeave={onPreviewEnd}
    >
      <button
        type="button"
        className="skin-card-preview"
        style={previewStyle}
        onClick={onApply}
        aria-pressed={active}
        aria-label={t("skins.applyNamed", { name: skin.name })}
      >
        {bgUrl ? (
          skin.background.kind === "video" ? (
            <video className="skin-card-media" src={bgUrl} muted loop playsInline autoPlay />
          ) : (
            <div className="skin-card-media" style={{ backgroundImage: `url("${bgUrl}")` }} />
          )
        ) : null}
        <div className={cx("skin-card-mini", isNone && "is-none")}>
          <div className="skin-card-mini-side" />
          <div className="skin-card-mini-main">
            <span className="skin-card-mini-bar" />
            <span className="skin-card-mini-bubble" />
            <span className="skin-card-mini-accent" />
          </div>
        </div>
        {active ? (
          <span className="skin-card-check" aria-hidden>
            <IconCheck size={14} />
          </span>
        ) : null}
      </button>
      <div className="skin-card-foot">
        <div className="skin-card-meta">
          <span className="skin-card-name">{skin.name}</span>
          <span className="skin-card-type">
            {skin.background.kind === "video" ? (
              <IconVideo size={11} aria-hidden />
            ) : skin.background.kind === "image" ? (
              <IconImage size={11} aria-hidden />
            ) : null}
            {typeLabel}
          </span>
        </div>
        {editable ? (
          <div className="skin-card-tools">
            {onEdit ? (
              <button type="button" className="skin-card-tool" onClick={onEdit} aria-label={t("skins.edit")} title={t("skins.edit")}>
                <IconPencil size={13} />
              </button>
            ) : null}
            {onExport ? (
              <button type="button" className="skin-card-tool" onClick={onExport} aria-label={t("skins.export")} title={t("skins.export")}>
                <IconUpload size={13} />
              </button>
            ) : null}
            {onDelete ? (
              <button type="button" className="skin-card-tool is-danger" onClick={onDelete} aria-label={t("skins.delete")} title={t("skins.delete")}>
                <IconTrash size={13} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
