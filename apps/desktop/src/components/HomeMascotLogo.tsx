import mascotUrl from "../assets/home-mascot.png";

/**
 * The home empty-state brand mark. A single transparent-background cutout of the
 * fox — no theme/skin variants: because the PNG has real alpha (no baked plate),
 * it sits cleanly on any theme, appearance, or skin wallpaper without a dark
 * square behind it, so there is nothing to adapt per look.
 */
export function HomeMascotLogo() {
  return (
    <span
      className="home-mascot-logo"
      data-testid="home-mascot-logo"
      aria-hidden="true"
    >
      <img
        className="home-mascot-mark"
        src={mascotUrl}
        alt=""
        width={100}
        height={100}
        draggable={false}
      />
    </span>
  );
}
