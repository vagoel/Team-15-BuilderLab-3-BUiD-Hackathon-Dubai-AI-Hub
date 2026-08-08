import { useEffect, useRef, useState } from "react";
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
  const { status: voiceStatus, isSpeaking, muted, error, inputLevel, start, stop, toggleMute, sendText } =
    useVoiceSession();

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status, progress]);

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
        <span className="chat-word">Loom</span>
        <span className="chat-dot" style={{ background: dotColor }} title={`voice: ${voiceStatus}`} />
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
        <form
          className="chat-input-row"
          onSubmit={(e) => {
            e.preventDefault();
            submitDraft();
          }}
        >
          <input
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

const chatLocalStyles = `
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px;
  border-bottom: 1px solid var(--line);
  flex: none;
}
.chat-word {
  font-weight: 800;
  font-size: 15px;
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
  border-radius: 8px;
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.35);
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
