import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePetMood } from "../hooks/use-pet-mood";
import { PET_MOOD_ANIM, type PetAnim, type PetMood } from "../lib/pet-mood";
import animIdle from "../assets/pet/anim/idle.webp";
import animThinking from "../assets/pet/anim/thinking.webp";
import animWorking from "../assets/pet/anim/working.webp";
import animSuccess from "../assets/pet/anim/success.webp";
import animError from "../assets/pet/anim/error.webp";
import animSleep from "../assets/pet/anim/sleep.webp";
import animSearching from "../assets/pet/anim/searching.webp";

/** One looping transparent WebP clip per animation key. */
const ANIM_URL: Record<PetAnim, string> = {
  idle: animIdle,
  thinking: animThinking,
  working: animWorking,
  success: animSuccess,
  error: animError,
  sleep: animSleep,
  searching: animSearching,
};

/** A speech line per mood; short so the bubble never crowds the corner. */
const MOOD_SAY: Record<PetMood, string> = {
  idle: "pet.say.idle",
  thinking: "pet.say.thinking",
  working: "pet.say.working",
  done: "pet.say.done",
  error: "pet.say.error",
  permission: "pet.say.permission",
  sleep: "",
};

type Vec = { v: number; t: number };

/**
 * The desktop companion ("千凝" pet, D664). A transparent full-body fox that
 * plays a real per-state frame animation (foot-aligned WebP clips rendered from
 * the mascot state videos) mirroring the active session's agent mood from
 * `usePetMood` (read-only). The clip itself carries the character motion
 * (breathing, tail sway, blink); a light requestAnimationFrame loop adds an
 * idle float, a spring-driven lean toward the cursor, and a click recoil so it
 * still feels responsive. Rendered only when `settings.petEnabled` is on and
 * mounted inside the chat shell so it shares the theme surface and never covers
 * the window controls.
 */
export function DesktopPet() {
  const { t } = useTranslation();
  const mood = usePetMood();
  const moodRef = useRef<PetMood>(mood);

  const slotRef = useRef<HTMLDivElement | null>(null);
  const rigRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<HTMLDivElement | null>(null);

  const [bubble, setBubble] = useState<string>("");
  const bubbleTimer = useRef<number | undefined>(undefined);

  // Spring state lives in a ref so the rAF loop mutates it without re-rendering.
  const S = useRef({
    rotY: { v: 0, t: 0 } as Vec,
    sc: { v: 0, t: 1 } as Vec,
    rotYCur: 0,
    scCur: 1,
    bob: Math.random() * 6,
  });
  const pointer = useRef({ x: 0, y: 0, inside: false });
  const dragging = useRef(false);

  const say = useCallback((text: string) => {
    setBubble(text);
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setBubble(""), 2600);
  }, []);

  // Mood changes swap the clip (via render) and speak a short line.
  useEffect(() => {
    moodRef.current = mood;
    const key = MOOD_SAY[mood];
    if (key) say(t(key));
    else setBubble("");
  }, [mood, say, t]);

  // The interactive loop. One rAF for the whole lifetime of the component.
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const spring = (cur: number, s: Vec, k: number, d: number, dt: number) => {
      const a = (s.t - cur) * k - s.v * d;
      s.v += a * dt;
      return cur + s.v * dt;
    };
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = S.current;
      const asleep = moodRef.current === "sleep";

      st.bob += dt * (asleep ? 0.9 : 1.6);
      const float = Math.sin(st.bob) * (asleep ? 2 : 4);

      let targetRotY = 0;
      if (pointer.current.inside && !dragging.current && rigRef.current) {
        const r = rigRef.current.getBoundingClientRect();
        const cx = r.left + r.width * 0.5;
        targetRotY = Math.max(-18, Math.min(18, ((pointer.current.x - cx) / r.width) * 40));
      }
      st.rotY.t = targetRotY;
      st.rotYCur = spring(st.rotYCur, st.rotY, 80, 13, dt);
      st.scCur = spring(st.scCur, st.sc, 150, 12, dt);

      if (rigRef.current) {
        rigRef.current.style.transform = `translateY(${float.toFixed(2)}px) rotateY(${st.rotYCur.toFixed(2)}deg) scale(${st.scCur.toFixed(3)})`;
      }
      if (shadowRef.current) {
        const lift = Math.max(0, -float);
        const sc = 1 - Math.min(0.3, lift / 40);
        shadowRef.current.style.transform = `translateX(-50%) scale(${sc.toFixed(3)})`;
        shadowRef.current.style.opacity = (0.42 * sc + 0.12).toFixed(3);
      }
      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  useEffect(
    () => () => {
      if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    },
    [],
  );

  const onPointerMove = (e: React.PointerEvent) => {
    pointer.current.x = e.clientX;
    pointer.current.y = e.clientY;
    pointer.current.inside = true;
    if (dragging.current && slotRef.current) {
      const el = slotRef.current as HTMLElement & { _dx?: number; _dy?: number; _r?: number; _b?: number };
      const dx = e.clientX - (el._dx ?? e.clientX);
      const dy = e.clientY - (el._dy ?? e.clientY);
      el.style.right = `${Math.max(6, (el._r ?? 0) - dx)}px`;
      el.style.bottom = `${Math.max(6, (el._b ?? 0) - dy)}px`;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true;
    const el = slotRef.current as (HTMLElement & { _dx?: number; _dy?: number; _r?: number; _b?: number }) | null;
    if (el) {
      const cs = getComputedStyle(el);
      el._dx = e.clientX;
      el._dy = e.clientY;
      el._r = parseFloat(cs.right) || 0;
      el._b = parseFloat(cs.bottom) || 0;
    }
    rigRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerUp = () => {
    dragging.current = false;
  };

  const onClick = () => {
    if (dragging.current) return;
    S.current.sc.v = 7; // a quick recoil pop
    say(t(moodRef.current === "sleep" ? "pet.say.woke" : "pet.say.poke"));
  };

  const clip = ANIM_URL[PET_MOOD_ANIM[mood]];

  return (
    <div
      className="pet-slot"
      ref={slotRef}
      data-testid="desktop-pet"
      onPointerMove={onPointerMove}
      onPointerLeave={() => {
        pointer.current.inside = false;
      }}
    >
      {bubble ? (
        <div className="pet-bubble" role="status">
          {bubble}
        </div>
      ) : null}
      <div className={`pet-glow${mood === "working" ? " on" : ""}`} aria-hidden />
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className="pet-rig"
        ref={rigRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClick}
        role="img"
        aria-label={t("pet.ariaLabel")}
      >
        <img className="pet-anim" src={clip} alt="" draggable={false} />
      </div>
      <div className="pet-shadow" ref={shadowRef} aria-hidden />
    </div>
  );
}
