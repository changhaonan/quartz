// Global language toggle — mirrors darkmode.inline.ts. The chosen locale lives
// in localStorage and on <html data-lang>, so every client-side widget (the
// dashboard, and any future one) reads ONE shared setting and reacts to the
// `langchange` event. Quartz's own core UI stays at the build-time cfg.locale.

type Lang = "zh-CN" | "en-US"

const savedLang = localStorage.getItem("lang")
const currentLang: Lang = savedLang === "en-US" || savedLang === "zh-CN" ? savedLang : "zh-CN"
document.documentElement.setAttribute("data-lang", currentLang)

const emitLangChangeEvent = (lang: Lang) => {
  document.dispatchEvent(new CustomEvent("langchange", { detail: { lang } }))
}

document.addEventListener("nav", () => {
  const switchLang = () => {
    const next: Lang =
      document.documentElement.getAttribute("data-lang") === "zh-CN" ? "en-US" : "zh-CN"
    document.documentElement.setAttribute("data-lang", next)
    localStorage.setItem("lang", next)
    emitLangChangeEvent(next)
  }

  for (const langButton of document.getElementsByClassName("langtoggle")) {
    langButton.addEventListener("click", switchLang)
    window.addCleanup(() => langButton.removeEventListener("click", switchLang))
  }
})
