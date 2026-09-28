import { useEffect, useState } from "react";
// Renderer-sized copies of the brand marks. The 1024px masters in build/ are
// installer icons for electron-builder; BrandLogo never renders above 64px.
import brandLogoUrlLight from "../assets/brand/logo-light.png";
import brandLogoUrlDark from "../assets/brand/logo-dark.png";
import brandLogoUrlFox from "../assets/brand/logo-fox.png";

type BrandVariant = "light" | "dark" | "fox";

/** Pick the brand mark that matches the active theme/appearance. */
function readVariant(): BrandVariant {
  const el = document.documentElement;
  // The 千凝 appearance layers on the dark base but ships its own navy mark.
  if (el.dataset.appearance === "fox") return "fox";
  return el.dataset.theme === "light" ? "light" : "dark";
}

const BRAND_SRC: Record<BrandVariant, string> = {
  light: brandLogoUrlLight,
  dark: brandLogoUrlDark,
  fox: brandLogoUrlFox,
};

export function BrandLogo({ size = 16 }: { size?: number }) {
  const [variant, setVariant] = useState<BrandVariant>(() => readVariant());

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setVariant(readVariant());
    });
    observer.observe(el, { attributes: true, attributeFilter: ["data-theme", "data-appearance"] });
    return () => observer.disconnect();
  }, []);

  return (
    <img
      className="brand-logo"
      src={BRAND_SRC[variant]}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
