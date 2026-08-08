import { useEffect, useRef, useState } from "react";
import { applyTheme, getTheme, resolvedTheme, type Theme } from "../lib/theme.js";
import { useLoom } from "../store.js";
import { useVoiceSession } from "../voice/useVoiceSession.js";

/**
 * The left rail. Narrow on purpose (see styles.css `--chat-w`) — the canvas is the
 * product, this is the transcript of how it got built plus the mic that drives it.
 */
export function ChatPanel() {
  const messages = useLoom((s) => s.messages);
  const status = useLoom((s) => s.status);
  const progress = useLoom((s) => s.progress);
  const queuedPrompt = useLoom((s) => s.queuedPrompt);
  const { status: voiceStatus, isSpeaking, muted, error, inputLevel, start, stop, toggleMute, sendText } =
    useVoiceSession();

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status, progress]);

  // An example prompt was clicked in the canvas: drop it into the input and focus so the
  // user can start the mic (or send once connected). We don't auto-send — sendText needs a
  // live session, and silently starting the mic on a click would be surprising.
  useEffect(() => {
    if (!queuedPrompt) return;
    setDraft(queuedPrompt);
    inputRef.current?.focus();
    useLoom.getState().setQueuedPrompt(null);
  }, [queuedPrompt]);

  const dotColor =
    voiceStatus === "error"
      ? "var(--bad)"
      : voiceStatus === "connected"
        ? "var(--good)"
        : voiceStatus === "connecting"
          ? "var(--warn)"
          : "var(--dim)";

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    sendText(text);
  };

  return (
    <aside className="chat">
      <style>{chatLocalStyles}</style>

      <header className="chat-head">
        <span className="chat-word">Scry</span>
        <div className="chat-head-right">
          <ThemeToggle />
          <span className="chat-dot" style={{ background: dotColor }} title={`voice: ${voiceStatus}`} />
        </div>
      </header>

      {error && (
        <div className="chat-error" role="alert">
          {error}
        </div>
      )}

      <div className="chat-scroll scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="chat-empty">Say what you want to research, or type it below.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-line chat-line--${m.role}${m.kind ? ` chat-line--${m.kind}` : ""}`}>
            {m.text}
          </div>
        ))}
        {status === "researching" && (
          <div className="chat-line chat-line--status chat-progress">
            <span className="spinner" />
            <span>
              {progress?.label ?? "Researching…"}
              {progress ? ` (${progress.done}/${progress.total})` : ""}
            </span>
          </div>
        )}
      </div>

      <div className="chat-foot">
        {/*
          Typing is hidden, not deleted. This is a voice product and the text row read
          as the primary way in; the form, its submit path and the queued-prompt plumbing
          all still work, so restoring it is a matter of dropping the `hidden` attribute.
        */}
        <form
          hidden
          className="chat-input-row"
          onSubmit={(e) => {
            e.preventDefault();
            submitDraft();
          }}
        >
          <input
            ref={inputRef}
            className="chat-input"
            type="text"
            placeholder="Type instead of talking…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="chat-send" disabled={!draft.trim()}>
            Send
          </button>
        </form>

        <div className="chat-mic-row">
          <button
            type="button"
            className={
              "chat-mic" +
              (voiceStatus === "connected" ? " chat-mic--live" : "") +
              (isSpeaking ? " chat-mic--speaking" : "")
            }
            style={{ ["--ring" as string]: String(0.35 + inputLevel * 0.65) }}
            onClick={() => (voiceStatus === "connected" || voiceStatus === "connecting" ? stop() : start())}
            aria-label={voiceStatus === "connected" ? "End call" : "Start voice session"}
          >
            {voiceStatus === "connecting" ? "…" : voiceStatus === "connected" ? "●" : "Start"}
          </button>

          {voiceStatus === "connected" && (
            <div className="chat-mic-controls">
              <button type="button" className="chat-chip-btn" onClick={toggleMute}>
                {muted ? "Unmute" : "Mute"}
              </button>
              <button type="button" className="chat-chip-btn chat-chip-btn--end" onClick={() => stop()}>
                End
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * Light / dark switch. Holds only the current choice — the actual palette lives
 * in styles.css and is selected by an attribute on <html>, so flipping it costs
 * one DOM write and no re-render below this component.
 */
function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const showing = resolvedTheme(theme);

  // "system" resolves live, so a mid-session OS change has to redraw the icon.
  useEffect(() => {
    if (theme !== "system" || typeof matchMedia !== "function") return;
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  const next: Theme = showing === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="chat-theme"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      title={`Switch to ${next} mode`}
      aria-label={`Switch to ${next} mode`}
    >
      {showing === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />
    </svg>
  );
}

const chatLocalStyles = `
.chat-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.chat-theme {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--dim);
  transition: color 0.2s, background 0.2s;
}
.chat-theme:hover {
  color: var(--ink);
  background: var(--panel-2);
}
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.chat-word {
  font-family: var(--font-display);
  font-optical-sizing: auto;
  font-weight: 600;
  font-size: var(--text-lg);
  letter-spacing: -0.01em;
}
.chat-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: none;
  transition: background 0.25s;
}
.chat-error {
  margin: 10px 14px 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: color-mix(in oklch, var(--bad) 12%, transparent);
  border: 1px solid color-mix(in oklch, var(--bad) 35%, transparent);
  color: var(--bad);
  font-size: 12.5px;
  line-height: 1.4;
  flex: none;
}
.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chat-empty {
  color: var(--dim);
  font-size: 13px;
  line-height: 1.5;
  margin-top: 8px;
}
.chat-line {
  font-size: 13.5px;
  line-height: 1.45;
  max-width: 94%;
}
.chat-line--user {
  align-self: flex-end;
  color: var(--mute);
  text-align: right;
}
.chat-line--agent {
  align-self: flex-start;
  color: var(--ink);
}
.chat-line--tool,
.chat-line--status {
  align-self: stretch;
  max-width: 100%;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: var(--dim);
  border-left: 2px solid var(--line);
  padding: 2px 0 2px 8px;
}
.chat-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  border-left: 2px solid var(--accent);
  color: var(--mute);
}
.chat-foot {
  flex: none;
  border-top: 1px solid var(--line);
  padding: 12px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.chat-input-row {
  display: flex;
  gap: 6px;
}
/* The flex rule above outranks the UA stylesheet's display:none for the hidden
   attribute, so hiding the typing row needs this to actually take effect. */
.chat-input-row[hidden] {
  display: none;
}
.chat-input {
  flex: 1;
  min-width: 0;
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--ink);
  font-size: 13px;
}
.chat-input:focus {
  outline: none;
  border-color: var(--accent);
}
.chat-send {
  border: 1px solid var(--line);
  background: var(--panel-2);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--mute);
}
.chat-send:not(:disabled):hover {
  color: var(--ink);
  border-color: var(--accent);
}
.chat-send:disabled {
  opacity: 0.5;
  cursor: default;
}
.chat-mic-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
}
.chat-mic {
  --ring: 0.35;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  flex: none;
  background: var(--panel-2);
  border: 1px solid var(--line);
  color: var(--mute);
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 4px transparent;
  transition: box-shadow 0.15s, background 0.2s, color 0.2s, border-color 0.2s;
}
.chat-mic--live {
  color: var(--good);
  border-color: var(--good);
  box-shadow: 0 0 0 calc(4px + var(--ring) * 8px) rgba(0, 211, 167, calc(0.05 + var(--ring) * 0.18));
}
.chat-mic--speaking {
  color: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 0 calc(4px + var(--ring) * 8px) rgba(91, 140, 255, calc(0.08 + var(--ring) * 0.22));
}
.chat-mic-controls {
  display: flex;
  gap: 6px;
}
.chat-chip-btn {
  border: 1px solid var(--line);
  background: var(--panel-2);
  border-radius: 20px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--mute);
}
.chat-chip-btn:hover {
  color: var(--ink);
}
.chat-chip-btn--end:hover {
  color: var(--bad);
  border-color: var(--bad);
}
`;
