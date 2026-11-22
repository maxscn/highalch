import { useSyncExternalStore } from "react";

/**
 * Light or dark: the `dark` class on `<html>`, remembered under `highalch:theme` (the inline
 * script in the document head applies it before the first paint, falling back to the system
 * preference). The toggle writes both; components read the class through an external store.
 */
export const themeKey = "highalch:theme";

/** Runs in the document head, before paint. */
export const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(themeKey)});if(t==="dark"||(t===null&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`;

const subscribe = (changed: () => void) => {
  // The document's own window's observer (a story's DOM is not the test environment's).
  const Observer = document.defaultView?.MutationObserver ?? MutationObserver;
  const observer = new Observer(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};

const isDark = () => document.documentElement.classList.contains("dark");

export const useDark = () => useSyncExternalStore(subscribe, isDark, () => false);

export const toggleTheme = () => {
  const dark = !isDark();
  document.documentElement.classList.toggle("dark", dark);
  try {
    localStorage.setItem(themeKey, dark ? "dark" : "light");
  } catch {
    // storage unavailable (private mode): the choice lasts for this page only
  }
};
