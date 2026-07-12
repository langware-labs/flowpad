/* deck.js — headless Reveal bootstrap.
 * Reveal handles navigation/fullscreen/keyboard/touch/presenter/overview/
 * transitions ONLY; all visuals come from tokens.css + theme.css.
 * hash:false / history:false are REQUIRED — decks render in a sandboxed
 * srcDoc iframe with no same-origin, no base URL, and no URL hash. */
(function () {
  function boot() {
    if (typeof Reveal === "undefined") return;
    Reveal.initialize({
      hash: false,
      history: false,
      center: false,
      transition: "fade",
      width: 1280,
      height: 720,
      margin: 0,
      controls: true,
      progress: true,
      overview: true,
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
