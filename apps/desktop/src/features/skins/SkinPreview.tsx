import type { CSSProperties, ReactNode } from "react";
import type { Skin } from "@pi-desktop/shared";
import { skinAssetUrl } from "../../lib/skin-engine";
import { previewVariables } from "./model";

/**
 * The miniature app window.
 *
 * One component, three sizes, one source of truth: the stage hero, the rail
 * thumbnails and the editor preview must never disagree about how a palette
 * reads. Colour comes from `--sk-*` properties (model.previewVariables), so a
 * preset looks the way it will look once applied — and an image/video skin
 * previews its own wallpaper underneath the chrome.
 *
 * The two densities are deliberate: a 96px tile cannot hold type, so it draws
 * bars; the stage can, so it draws a real conversation. Rendering the same text
 * into both would make the tile a grey smear.
 */
export type SkinPreviewVariant = "stage" | "tile" | "editor";

type Props = {
  skin: Pick<Skin, "id" | "tokens" | "base" | "background">;
  variant?: SkinPreviewVariant;
  className?: string;
  /** Overlays (caption, tools) drawn inside the preview so they inherit `--sk-*`. */
  children?: ReactNode;
};

const SAMPLE = {
  title: "千凝",
  status: "在线",
  bot: "今晚的稿子改完了，你看看雨中那一段。",
  me: "第三页？我留了标记。",
  botAlt: "嗯。灯下那段，别删。",
  placeholder: "继续写…",
};

export function SkinPreview({ skin, variant = "tile", className, children }: Props) {
  const dense = variant === "tile";
  const themed = skin.id === "none";
  // `跟随主题` carries no tokens: setting the fallbacks inline would paint a
  // hard-coded dark window, so the class maps `--sk-*` onto the live theme
  // instead — the only way a preview can look like the app it is previewing.
  const style = themed ? undefined : (previewVariables(skin) as CSSProperties);
  // A sanitized media skin always carries both fields; a hand-edited one may not,
  // and a preview must not throw on the page that lists every skin.
  const { assetId, ext } = skin.background;
  const live = skin.background.kind === "scene" || skin.background.kind === "web";
  // A live project cannot be mounted inside a 152px thumbnail, but most of them
  // ship a still. It is served from the project root itself, so the card shows
  // the real artwork instead of an empty gradient.
  const still =
    live && skin.background.projectId && skin.background.preview
      ? `wallpaper://project/${skin.background.projectId}/${skin.background.preview}`
      : null;
  const media = skin.background.kind !== "none" && assetId && ext ? skinAssetUrl(assetId, ext) : null;
  const classes = [
    "skp",
    `skp--${variant}`,
    themed ? "is-theme" : "",
    still || media ? "has-media" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} style={style} aria-hidden="true">
      {still ? <img className="skp-media" src={still} alt="" /> : null}
      {media ? (
        skin.background.kind === "video" ? (
          <video className="skp-media" src={media} muted loop autoPlay playsInline preload="metadata" />
        ) : (
          <img className="skp-media" src={media} alt="" />
        )
      ) : null}
      {still || media ? (
        <div
          className="skp-scrim"
          style={{ opacity: "scrim" in skin.background ? skin.background.scrim : 0.4 }}
        />
      ) : null}
      <div className="skp-veil" />

      <div className="skp-window">
        <div className="skp-rail">
          <span className="skp-brand" />
          <span className="skp-nav is-active" />
          <span className="skp-nav" />
          <span className="skp-nav" />
          <span className="skp-nav is-short" />
          <span className="skp-rail-foot" />
        </div>

        <div className="skp-body">
          <div className="skp-top">
            <span className="skp-title">
              <span className="skp-dot" />
              {dense ? <span className="skp-bar is-name" /> : <span className="skp-name">{SAMPLE.title}</span>}
            </span>
            {dense ? (
              <span className="skp-bar is-status" />
            ) : (
              <span className="skp-status">{SAMPLE.status}</span>
            )}
          </div>

          <div className="skp-chat">
            <div className="skp-row">
              <span className="skp-avatar" />
              <span className="skp-bubble">
                {dense ? <span className="skp-bar is-80" /> : <span className="skp-text">{SAMPLE.bot}</span>}
              </span>
            </div>
            <div className="skp-row is-me">
              <span className="skp-bubble is-accent">
                {dense ? <span className="skp-bar is-60" /> : <span className="skp-text">{SAMPLE.me}</span>}
              </span>
            </div>
            <div className="skp-row">
              <span className="skp-avatar" />
              <span className="skp-bubble">
                {dense ? <span className="skp-bar is-50" /> : <span className="skp-text">{SAMPLE.botAlt}</span>}
              </span>
            </div>
          </div>

          <div className="skp-composer">
            <span className="skp-placeholder">{dense ? <span className="skp-bar is-40" /> : SAMPLE.placeholder}</span>
            <span className="skp-send" />
          </div>
        </div>
      </div>

      {children}
    </div>
  );
}
