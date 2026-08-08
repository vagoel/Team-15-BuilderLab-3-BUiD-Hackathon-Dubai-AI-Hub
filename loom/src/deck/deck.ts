import Reveal from "reveal.js";
import Markdown from "reveal.js/plugin/markdown";
import "reveal.js/reveal.css";
import "./deck.css";
import deckMd from "./deck.md?raw";

/**
 * The pitch deck, served at /deck.html from the same deployment as the app.
 *
 * Slides are authored in deck.md — the single source of truth — and split on
 * `===` lines. Visual set pieces are inline HTML/SVG styled in deck.css, so the
 * whole deck ships as one static entry with no runtime beyond Reveal itself.
 */
const slides = document.querySelector(".reveal .slides");
if (!slides) throw new Error("deck: .reveal .slides mount point missing");

const section = document.createElement("section");
section.setAttribute("data-markdown", "");
section.setAttribute("data-separator", "^\\r?\\n===\\r?\\n$");

const template = document.createElement("script");
template.type = "text/template";
template.textContent = deckMd;
section.appendChild(template);
slides.appendChild(section);

const deck = new Reveal({
  plugins: [Markdown],
  width: 1280,
  height: 720,
  margin: 0.07,
  hash: true,
  transition: "fade",
  transitionSpeed: "slow",
  backgroundTransition: "none",
  controls: true,
  controlsTutorial: false,
  progress: true,
  center: true,
});

void deck.initialize();
