import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";

import { App } from "@/app/App";
import "@/styles/globals.css";

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const anchor = target.closest('a[href^="#"]');
  if (!(anchor instanceof HTMLAnchorElement)) {
    return;
  }
  const href = anchor.getAttribute("href");
  if (!href || href === "#") {
    return;
  }
  const id = href.slice(1);
  const section = document.getElementById(id);
  if (!section) {
    return;
  }
  event.preventDefault();
  section.scrollIntoView({ behavior: "smooth", block: "start" });
  history.pushState(null, "", href);
});

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </StrictMode>,
);
