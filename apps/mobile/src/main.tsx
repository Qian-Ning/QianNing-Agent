import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
// The desktop's token file is the visual source of truth; the phone reads the
// same palette, radii and type ramp instead of keeping a second copy that drifts.
import "../../desktop/src/styles/tokens.css";
import "./scales.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("the page has no #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
