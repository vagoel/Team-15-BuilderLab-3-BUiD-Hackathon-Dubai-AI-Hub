import { useCallback, useEffect, useRef, useState } from "react";
import { Conversation } from "@elevenlabs/client";
import type { Role } from "@elevenlabs/client";
import { useLoom } from "../store.js";
import { useTemplates } from "../templates/templateStore.js";
import { serializeTemplateContext } from "../contract/template.js";
import { createToolHandlers } from "./toolHandlers.js";

declare const __AGENT_ID__: string;

/**
 * Decides whether a session that just finished connecting should be adopted as the
 * live session, or torn back down.
 *
 * Pulled out as a small pure function (rather than inlined in `start()`) so the
 * "stop pressed mid-connect" race can be unit tested without a DOM, a mocked
 * Conversation SDK, or React itself: capture `epoch` from the epoch ref before the
 * awaits in `start()`, then compare it against the ref's current value once they
 * resolve. If they disagree, something superseded this attempt — most commonly the
 * user pressing Stop while still connecting, which used to be silently ignored
 * because there was no live `conversationRef` yet for `stop()` to act on, so the
 * connection finished anyway and flipped the UI back to "connected" moments after
 * the user asked to end it.
 */
export function shouldAdoptSession(mounted: boolean, capturedEpoch: number, currentEpoch: number): boolean {
  return mounted && capturedEpoch === currentEpoch;
}

/**
 * Stops every track on a stream. Duck-typed on the one method used, so it can be
 * unit tested with a plain fake object instead of a real `MediaStream`.
 *
 * `start()` requests a stream purely to trigger the browser's mic-permission prompt
 * up front, before `Conversation.startSession` opens its own — holding onto it
 * afterwards would leave a live, unused capture track open (the tab's recording
 * indicator lit) for as long as the page stays open, and every start/stop cycle
 * would pile up one more.
 */

/**
 * Owns the ElevenLabs `Conversation` instance and exposes it as React state.
 *
 * The session itself is not store state (it's a live object with sockets and audio
 * worklets, not serializable) — only its *shape* (status, error, levels) is. Every
 * side effect the agent produces on the app goes through the client tools bound in
 * `toolHandlers.ts`, which write into `useLoom` directly; this hook only manages the
 * connection lifecycle and mirrors a couple of connection-only signals React needs
 * for the mic button (mode, input level).
 */

export type VoiceStatus = "idle" | "connecting" | "connected" | "error";

export interface UseVoiceSession {
  status: VoiceStatus;
  isSpeaking: boolean;
  muted: boolean;
  error: string | null;
  inputLevel: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggleMute: () => void;
  sendText: (text: string) => void;
}

export function useVoiceSession(): UseVoiceSession {
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputLevel, setInputLevel] = useState(0);

  const conversationRef = useRef<Conversation | null>(null);
  // Guards React 19 StrictMode's dev-only double-invoke of effects/callbacks, and a
  // stray double-click on the mic button, from opening two sessions at once.
  const startingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // Bumped by every `start()` and every `stop()`. `start()` captures the value before
  // its awaits; if it no longer matches when `Conversation.startSession` resolves,
  // something superseded this attempt — most commonly the user pressing Stop while
  // still connecting — so the session that just opened is torn straight back down
  // instead of quietly becoming "the" session and flipping the UI back to connected
  // after the user asked to end it.
  const sessionEpochRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stopLevelLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setInputLevel(0);
  }, []);

  const startLevelLoop = useCallback(() => {
    const tick = () => {
      const convo = conversationRef.current;
      if (!convo) return;
      try {
        const data = convo.getInputByteFrequencyData();
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] ?? 0;
        const avg = data.length ? sum / data.length / 255 : 0;
        setInputLevel(avg);
      } catch {
        // Not fatal — the worklet may not be ready for the first few frames.
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stop = useCallback(async () => {
    // Invalidates any `start()` still awaiting `Conversation.startSession` — without
    // this, pressing Stop while the mic was still connecting did nothing (there was
    // no live `conversationRef` yet to end), and the connection quietly finished
    // moments later, flipping the UI back to "connected" as if Stop had never been
    // pressed and leaving a live mic session the user believed they had ended.
    sessionEpochRef.current++;
    stopLevelLoop();
    // stop() bumps the epoch, which makes onDisconnect return early — so unpin here
    // too, or an explicitly ended session would leave the rail locked forever.
    useTemplates.getState().unpinTemplate();
    const convo = conversationRef.current;
    conversationRef.current = null;
    if (convo) {
      try {
        await convo.endSession();
      } catch {
        // Already gone — fine.
      }
    }
    if (mountedRef.current) {
      setStatus("idle");
      setIsSpeaking(false);
    }
    if (useLoom.getState().status === "listening" || useLoom.getState().status === "connecting") {
      useLoom.getState().setStatus("idle");
    }
  }, [stopLevelLoop]);

  /**
   * `connectionType` is honoured, but note the SDK infers it from the conversation
   * mode: a voice session is always WebRTC, and WebSocket is for text-only. Passing
   * "websocket" for a voice session does not change the transport, which is why there
   * is no automatic transport fallback here — it would only produce a second identical
   * failure and a more confusing log.
   */
  const startWithTransport = useCallback(async (connectionType: "webrtc" | "websocket") => {
    if (startingRef.current || conversationRef.current) return;

    if (!__AGENT_ID__) {
      setError(
        "No ElevenLabs agent configured. Set ELEVENLABS_AGENT_ID in the workspace .env " +
          "(next to this app's package.json or one level up) and restart the dev server.",
      );
      useTemplates.getState().unpinTemplate();
      setStatus("error");
      return;
    }

    startingRef.current = true;
    const epoch = ++sessionEpochRef.current;
    setError(null);
    setStatus("connecting");
    useLoom.getState().setStatus("connecting");

    // Freeze the selected template for the whole session. The same snapshot is
    // described to the agent below and used by the renderer (see
    // `mountDataset`), so the agent's instructions and the canvas cannot drift
    // apart mid-conversation. The rail disables selection until disconnect.
    const pinned = useTemplates.getState().pinTemplate();


    try {
      // We deliberately do NOT open our own microphone here.
      //
      // Doing so — even briefly, to surface the permission prompt at a predictable
      // moment — leaves a second capture of the same device alive across the SDK's
      // handshake, and the session then dies at "publishing track": the LiveKit room
      // connects, the track fails to publish, the server deletes the room (reason 5)
      // and the SDK throws parsing the error payload. Releasing our stream first
      // instead is no better; it stops the only live track microseconds before the SDK
      // asks for one. The microphone belongs to the SDK. It raises the permission
      // prompt itself on the first attempt.
      await assertMicrophoneUsable();


      const conversation = await Conversation.startSession({
        agentId: __AGENT_ID__,
        connectionType,
        clientTools: createToolHandlers(),
        // Dynamic variables rather than a prompt override: this is a PUBLIC agent,
        // and enabling full prompt overrides on one would let any browser rewrite
        // its instructions. The prompt carries {{report_template_context}} and this
        // fills it in — "NONE" when nothing is selected.
        dynamicVariables: { report_template_context: serializeTemplateContext(pinned) },
        onConnect: () => {
          if (!mountedRef.current) return;
          setStatus("connected");
          useLoom.getState().setStatus("listening");
        },
        onDisconnect: () => {
          // Ignore a callback belonging to a session we have already replaced or
          // ended. Without this, a late event from a previous connection tears down
          // the live one and the UI reports "idle" over a session that is still up.
          if (sessionEpochRef.current !== epoch) return;


          // Clear the ref even if we unmounted or the user already called stop() —
          // otherwise it keeps pointing at a dead session forever, which makes every
          // future `start()` a silent no-op (its guard sees a truthy `conversationRef`
          // and returns immediately) and leaves the level-meter loop polling a
          // conversation that will never answer again.
          conversationRef.current = null;
          stopLevelLoop();
          // Session over: the template is no longer pinned, so the rail unlocks and
          // the next session can start from a different selection.
          useTemplates.getState().unpinTemplate();
          if (!mountedRef.current) return;
          setStatus("idle");
          setIsSpeaking(false);
          if (useLoom.getState().status === "listening" || useLoom.getState().status === "connecting") {
            useLoom.getState().setStatus("idle");
          }
        },
        onError: (message) => {
          if (sessionEpochRef.current !== epoch) return;


          // Same reasoning as onDisconnect: a runtime error does not otherwise clear
          // conversationRef, which would permanently disable the Start button (it
          // reads "error" but a click calls start(), which no-ops on a stale ref).
          conversationRef.current = null;
          stopLevelLoop();
          if (!mountedRef.current) return;
          setError(message);
          useTemplates.getState().unpinTemplate();
      setStatus("error");
          useLoom.getState().setError(message);
        },
        onModeChange: ({ mode }) => {
          if (!mountedRef.current) return;
          setIsSpeaking(mode === "speaking");
        },
        onMessage: (payload) => {
          handleIncomingMessage(payload);
        },
      });

      // The caller may have unmounted, or called stop() (or a newer start()) while
      // this was in flight — tear the fresh session straight back down rather than
      // adopt it and leak it.
      if (!shouldAdoptSession(mountedRef.current, epoch, sessionEpochRef.current)) {
        void conversation.endSession().catch(() => {});
        return;
      }

      conversationRef.current = conversation;
      startLevelLoop();

    } catch (err) {
      if (!mountedRef.current) return;


      const message = explainStartFailure(err);
      setError(message);
      useTemplates.getState().unpinTemplate();
      setStatus("error");
      useLoom.getState().setError(message);
    } finally {
      startingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startLevelLoop, stopLevelLoop]);

  /** Public entry point. `?transport=websocket` is available for text-only debugging. */
  const start = useCallback(async () => {
    const forced = new URLSearchParams(location.search).get("transport");
    await startWithTransport(forced === "websocket" ? "websocket" : "webrtc");
  }, [startWithTransport]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      conversationRef.current?.setMicMuted(next);
      return next;
    });
  }, []);

  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const convo = conversationRef.current;
    if (!convo) {
      useLoom.getState().addMessage({ role: "system", kind: "status", text: "Not connected — start the mic first." });
      return;
    }

    // The transcript line goes in only after the send call has not thrown.
    // Previously the message was logged first and sendUserMessage fired into a data
    // channel that was mid-reconnect — the SDK dropped it ("RTCDataChannel readyState
    // is not 'open'") and the transcript showed a message the agent never received,
    // which reads as the agent ignoring you. Retry briefly, then say it failed.
    const attempt = (remaining: number) => {
      const current = conversationRef.current;
      if (!current) {
        useLoom.getState().addMessage({ role: "system", kind: "status", text: "Message not sent — the call ended." });
        return;
      }
      try {
        current.sendUserMessage(trimmed);
        useLoom.getState().addMessage({ role: "user", text: trimmed });
      } catch {
        if (remaining > 0) {
          setTimeout(() => attempt(remaining - 1), 1200);
        } else {
          useLoom.getState().addMessage({
            role: "system",
            kind: "status",
            text: `Could not deliver "${trimmed.slice(0, 40)}" — the connection is unstable. Try again in a moment.`,
          });
        }
      }
    };
    attempt(3);
  }, []);

  // Belt-and-braces cleanup on unmount (covers navigation away / hot reload; the
  // StrictMode double-invoke is guarded by `startingRef`/`conversationRef` above).
  useEffect(() => {
    return () => {
      sessionEpochRef.current++;
      stopLevelLoop();
      const convo = conversationRef.current;
      conversationRef.current = null;
      if (convo) void convo.endSession().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, isSpeaking, muted, error, inputLevel, start, stop, toggleMute, sendText };
}

/**
 * The SDK's documented shape is `{ message: string, source: "user" | "ai" }`
 * (see @elevenlabs/types `Callbacks.onMessage`). We handle that plus a couple of
 * defensive fallbacks in case a future SDK build renames `source` to `role`, or
 * sends `"agent"` instead of `"ai"` — both have been observed in the wild across
 * ElevenLabs SDK versions.
 */
function handleIncomingMessage(payload: { message?: string; source?: Role | string; role?: string } | unknown): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as { message?: unknown; source?: unknown; role?: unknown };
  const text = typeof p.message === "string" ? p.message : undefined;
  if (!text) return;

  const rawSource = (typeof p.source === "string" ? p.source : typeof p.role === "string" ? p.role : "ai").toLowerCase();
  const role = rawSource === "user" ? "user" : "agent";

  useLoom.getState().addMessage({ role, text, kind: "speech" });
}

/**
 * Turn a start-up failure into something the user can act on.
 *
 * "Permission denied" and "NotAllowedError" are the same words whether the mic was
 * blocked, the tab is insecure, or the account is out of quota — and guessing between
 * them cost real debugging time. Name the actual cause and the actual fix.
 */
/**
 * Fail fast, and legibly, when the microphone is unusable.
 *
 * The Permissions API tells us "denied" without opening a capture, so we can give a
 * real explanation instead of letting the SDK fail opaquely mid-handshake. Where it is
 * unsupported or reports "prompt", we say nothing and let the SDK raise the prompt.
 */
async function assertMicrophoneUsable(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser cannot capture audio. Chrome or Safari over https/localhost works.");
  }
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    if (status?.state === "denied") {
      const err = new Error("Microphone permission is blocked for this site.");
      err.name = "NotAllowedError";
      throw err;
    }
  } catch (err) {
    // Firefox and older Safari do not support querying "microphone"; that is fine.
    if (err instanceof Error && err.name === "NotAllowedError") throw err;
  }
}

/** A permission or hardware problem fails the same way on either transport. */
function isPermissionProblem(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);
  return (
    name === "NotAllowedError" ||
    name === "NotFoundError" ||
    /permission denied|not allowed|no.*(device|microphone)/i.test(raw)
  );
}

function explainStartFailure(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const raw = err instanceof Error ? err.message : String(err);

  if (name === "NotAllowedError" || /permission denied|not allowed/i.test(raw)) {
    return (
      "Microphone blocked. Allow mic access for localhost in the browser's site " +
      "settings, then press Start again. You can still type in the box above."
    );
  }
  if (name === "NotFoundError" || /no.*(device|microphone)/i.test(raw)) {
    return "No microphone found. Plug one in, or type in the box above instead.";
  }
  if (/401|unauthorized/i.test(raw)) {
    return "ElevenLabs rejected the agent id. Check ELEVENLABS_AGENT_ID in the workspace .env.";
  }
  if (/402|payment|quota|credit|upgrade|paid_plan/i.test(raw)) {
    return (
      "ElevenLabs is out of quota on this account — the free tier is used up, so the " +
      "agent cannot speak. Upgrade the plan or use a different key. The dashboard and " +
      "every tool still work; open ?dev to drive them by button."
    );
  }
  if (/secure|https/i.test(raw)) {
    return "Microphone needs a secure context. Use http://localhost rather than a LAN IP.";
  }
  return `Could not start the session: ${raw}`;
}
