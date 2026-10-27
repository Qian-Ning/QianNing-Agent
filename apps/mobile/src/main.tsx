import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { ErrorBoundary } from "./views/error-boundary";
// The desktop's token file is the visual source of truth; the phone reads the
// same palette, radii and type ramp instead of keeping a second copy that drifts.
import "../../desktop/src/styles/tokens.css";
import "./scales.css";
import "./styles.css";
import { applySkin, loadSkinId } from "./lib/skin";

// Paint the desktop's skin before the first frame so nothing flashes the base
// theme on the way in.
applySkin(loadSkinId());

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root element");

// Anything thrown outside React's tree would otherwise leave a white page with
// no explanation, which is indistinguishable from a slow load.
function reportCrash(reason: unknown): void {
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  const panel = document.createElement("pre");
  panel.className = "crash-stack global";
  panel.textContent = message;
  document.body.append(panel);
}

window.addEventListener("error", (event) => reportCrash(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => reportCrash(event.reason));

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
