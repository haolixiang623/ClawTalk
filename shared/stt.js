export function createSpeechRecognitionAdapter({ lang }) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    return null;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = lang || "it-IT";
  recognition.continuous = false;
  recognition.interimResults = false;

  let active = false;
  let resultHandler = null;
  let errorHandler = null;

  recognition.addEventListener("result", (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join(" ")
      .trim();
    if (resultHandler) {
      resultHandler(transcript);
    }
  });

  recognition.addEventListener("error", (event) => {
    if (errorHandler) {
      // event.error is a short code like: "no-speech", "audio-capture", "not-allowed", "network", ...
      errorHandler({
        error: event?.error,
        message: event?.message,
        type: event?.type
      });
    }
  });

  return {
    start(onResult, onError) {
      if (active) return;
      resultHandler = onResult;
      errorHandler = onError;
      active = true;
      try {
        recognition.start();
      } catch (error) {
        // Can throw if called too quickly or in an unsupported context.
        active = false;
        if (errorHandler) {
          const msg = error instanceof Error ? error.message : String(error);
          errorHandler({ error: "start-failed", message: msg, type: "exception" });
        }
      }
    },
    stop() {
      if (!active) return;
      active = false;
      recognition.stop();
    },
    abort() {
      if (!active) return;
      active = false;
      recognition.abort();
    }
  };
}
