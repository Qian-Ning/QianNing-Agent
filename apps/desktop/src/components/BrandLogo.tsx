import brandLogoUrl from "../assets/brand/logo.png";

/**
 * The brand mark shown in the sidebar header and the startup splash. A single
 * transparent-background fox cutout with no theme/appearance variants: the PNG
 * carries real alpha (no baked plate), so it reads cleanly on light, dark, the
 * 千凝 appearance, and any skin wallpaper without a dark square behind it.
 */
export function BrandLogo({ size = 16 }: { size?: number }) {
  return (
    <img
      className="brand-logo"
      src={brandLogoUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
