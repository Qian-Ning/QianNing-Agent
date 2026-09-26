import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { usePetMood } from "../hooks/use-pet-mood";
import { PET_MOOD_FACES, type PetMood } from "../lib/pet-mood";
import foxHappy from "../assets/pet/fox-happy.png";
import foxWink from "../assets/pet/fox-wink.png";
import foxThinking from "../assets/pet/fox-thinking.png";
import foxSurprised from "../assets/pet/fox-surprised.png";
import foxShy from "../assets/pet/fox-shy.png";
import foxSmug from "../assets/pet/fox-smug.png";
import foxSleeping from "../assets/pet/fox-sleeping.png";
import foxScared from "../assets/pet/fox-scared.png";
import foxCrying from "../assets/pet/fox-crying.png";

const FACE_URL: Record<string, string> = {
  happy: foxHappy,
  wink: foxWink,
  thinking: foxThinking,
  surprised: foxSurprised,
  shy: foxShy,
  smug: foxSmug,
  sleeping: foxSleeping,
  scared: foxScared,
  crying: foxCrying,
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
 * The desktop companion ("千凝" pet, D633). A transparent fox cutout driven by a
 * requestAnimationFrame spring loop — it breathes, blinks, glances around while
 * idle, turns toward the cursor, and reacts to clicks — so it reads as a live
 * creature rather than a static image. Its face follows the active session's
 * agent mood from `usePetMood` (read-only). Rendered only when
 * `settings.petEnabled` is on; mounted inside the chat shell so it shares the
 * app's theme surface and never covers the window controls.
 */
export function DesktopPet() {
  const { t } = useTranslation();
  const mood = usePetMood();
  const moodRef = useRef<PetMood>(mood);

  const rigRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<HTMLDivElement | null>(null);
  const faceRef = useRef<HTMLImageElement | null>(null);
  const faceDepthRef = useRef<HTMLImageElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);

  const [bubble, setBubble] = useState<string>("");
  const bubbleTimer = useRef<number | undefined>(undefined);

  // Spring state lives in a ref so the rAF loop mutates it without re-rendering.
  const S = useRef({
    rotY: { v: 0, t: 0 } as Vec,
    rotX: { v: 0, t: 0 } as Vec,
    sx: { v: 0, t: 0 } as Vec,
    sy: { v: 0, t: 0 } as Vec,
    y: { v: 0, t: 0 } as Vec,
    sxCur: 1,
    syCur: 1,
    rotYCur: 0,
    rotXCur: 0,
    yCur: 0,
    breath: Math.random() * 6,
    tRotY: 0,
    tRotX: 0,
    blinkOn: false,
    nextWander: 0,
    nextBlink: 0,
  });
  const pointer = useRef({ x: 0, y: 0, inside: false });
  const dragging = useRef(false);

  const setFace = useCallback((faceKey: string) => {
    const url = FACE_URL[faceKey] ?? FACE_URL.happy;
    if (faceRef.current) faceRef.current.src = url;
    if (faceDepthRef.current) faceDepthRef.current.src = url;
  }, []);

  const say = useCallback((text: string) => {
    setBubble(text);
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setBubble(""), 2600);
  }, []);

  // Mood changes drive the face + one-shot reactions (hop on done, shake on error).
  useEffect(() => {
    moodRef.current = mood;
    setFace(PET_MOOD_FACES[mood]);
    S.current.blinkOn = false;
    if (mood === "done") S.current.y.v = -260;
    if (mood === "error") S.current.rotY.v = 520;
    if (mood === "permission") S.current.tRotX = 12;
    const key = MOOD_SAY[mood];
    if (key) say(t(key));
    else setBubble("");
  }, [mood, setFace, say, t]);

  // The spring puppet loop. One rAF for the whole lifetime of the component.
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
      const m = moodRef.current;
      const busy = m === "working";
      const asleep = m === "sleep";

      st.breath += dt * (asleep ? 1.1 : 1.9);
      const breath = Math.sin(st.breath);
      const bob = Math.sin(st.breath * (busy ? 1.7 : 1.0)) * (busy ? 7 : 4);
      st.sx.t = 1 - breath * 0.03;
      st.sy.t = 1 + breath * 0.045;

      if (pointer.current.inside && !dragging.current && rigRef.current) {
        const host = rigRef.current.offsetParent as HTMLElement | null;
        const r = (host ?? rigRef.current).getBoundingClientRect();
        const cx = r.left + r.width * 0.5;
        const cy = r.top + r.height * 0.5;
        st.tRotY = Math.max(-26, Math.min(26, ((pointer.current.x - cx) / r.width) * 70));
        st.tRotX = Math.max(-16, Math.min(16, (-(pointer.current.y - cy) / r.height) * 44));
      }
      if (m === "permission") st.tRotX = 12;

      // Idle wandering: occasional glance / hop / fur-shake for liveliness.
      const canWander = (m === "idle") && !dragging.current;
      if (canWander && now > st.nextWander) {
        st.nextWander = now + 1800 + Math.random() * 2800;
        const roll = Math.random();
        if (roll < 0.5) st.tRotY = (Math.random() * 2 - 1) * 22;
        else if (roll < 0.78) st.y.v = -150;
        else {
          st.sx.v = -1.2;
          st.sy.v = 1.2;
        }
      }
      // Blink by briefly swapping to the wink sprite.
      const canBlink = (m === "idle" || m === "working") && !st.blinkOn;
      if (canBlink && now > st.nextBlink) {
        st.nextBlink = now + 2200 + Math.random() * 2800;
        st.blinkOn = true;
        setFace("wink");
        window.setTimeout(() => {
          if (!st.blinkOn) return;
          setFace(PET_MOOD_FACES[moodRef.current]);
          st.blinkOn = false;
        }, 120);
      }

      st.rotYCur = spring(st.rotYCur, ((st.rotY.t = st.tRotY), st.rotY), 90, 14, dt);
      st.rotXCur = spring(st.rotXCur, ((st.rotX.t = st.tRotX), st.rotX), 90, 14, dt);
      st.sxCur = spring(st.sxCur, st.sx, 140, 12, dt);
      st.syCur = spring(st.syCur, st.sy, 140, 12, dt);
      st.yCur = spring(st.yCur, ((st.y.t = 0), st.y), 120, 11, dt);
      const totalY = st.yCur + bob;

      if (rigRef.current) {
        rigRef.current.style.transform = `translateY(${totalY.toFixed(2)}px) rotateX(${st.rotXCur.toFixed(2)}deg) rotateY(${st.rotYCur.toFixed(2)}deg) scale(${st.sxCur.toFixed(3)}, ${st.syCur.toFixed(3)})`;
      }
      if (shadowRef.current) {
        const lift = Math.max(0, -totalY);
        const sc = 1 - Math.min(0.4, lift / 60);
        shadowRef.current.style.transform = `translateX(-50%) scale(${sc.toFixed(3)})`;
        shadowRef.current.style.opacity = (0.5 * sc + 0.12).toFixed(3);
      }
      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);
    return () => window.cancelAnimationFrame(raf);
  }, [setFace]);

  useEffect(
    () => () => {
      if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    },
    [],
  );

  const react = useCallback(
    (faceKey: string, text: string, impulse?: () => void) => {
      setFace(faceKey);
      impulse?.();
      say(text);
      window.setTimeout(() => setFace(PET_MOOD_FACES[moodRef.current]), 1600);
    },
    [setFace, say],
  );

  const onPointerMove = (e: React.PointerEvent) => {
    pointer.current.x = e.clientX;
    pointer.current.y = e.clientY;
    pointer.current.inside = true;
    if (dragging.current && slotRef.current) {
      const el = slotRef.current;
      const dx = e.clientX - (el as HTMLElement & { _dx?: number })._dx!;
      const dy = e.clientY - (el as HTMLElement & { _dy?: number })._dy!;
      el.style.right = `${Math.max(6, (el as HTMLElement & { _r?: number })._r! - dx)}px`;
      el.style.bottom = `${Math.max(6, (el as HTMLElement & { _b?: number })._b! - dy)}px`;
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
    if (moodRef.current === "sleep") {
      react("surprised", t("pet.say.woke"));
      return;
    }
    react("surprised", t("pet.say.poke"), () => {
      S.current.y.v = -200;
    });
  };

  return (
    <div
      className="pet-slot"
      ref={slotRef}
      data-testid="desktop-pet"
      onPointerMove={onPointerMove}
      onPointerLeave={() => {
        pointer.current.inside = false;
        S.current.tRotY = 0;
        S.current.tRotX = 0;
      }}
    >
      {bubble ? (
        <div className="pet-bubble" role="status">
          {bubble}
        </div>
      ) : null}
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
        <div className={`pet-glow${mood === "working" ? " on" : ""}`} aria-hidden />
        <div className="pet-fox">
          <img className="pet-face-depth" ref={faceDepthRef} src={foxHappy} alt="" aria-hidden draggable={false} />
          <img className="pet-face" ref={faceRef} src={foxHappy} alt="" draggable={false} />
          <div className="pet-rim" aria-hidden />
        </div>
      </div>
      <div className="pet-shadow" ref={shadowRef} aria-hidden />
    </div>
  );
}
