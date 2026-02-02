function parseControlLine(text) {
  const firstLineEnd = text.indexOf("\n");
  if (firstLineEnd === -1) {
    return { control: null, text };
  }
  const firstLine = text.slice(0, firstLineEnd).trim();
  if (!firstLine.startsWith("{") || !firstLine.endsWith("}")) {
    return { control: null, text };
  }
  try {
    const control = JSON.parse(firstLine);
    const remaining = text.slice(firstLineEnd + 1).trim();
    return { control, text: remaining };
  } catch (error) {
    return { control: null, text };
  }
}

async function playSpeechSynthesis(text, { lang }) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang || "it-IT";
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    speechSynthesis.speak(utterance);
  });
}

function createMediaSourcePlayer({ signal }) {
  const mediaSource = new MediaSource();
  const audio = new Audio();
  audio.src = URL.createObjectURL(mediaSource);
  let sourceBuffer;
  let done = false;
  let reader = null;

  let resolveStopped;
  const stoppedPromise = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  const openPromise = new Promise((resolve) => {
    mediaSource.addEventListener(
      "sourceopen",
      () => {
        sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
        resolve();
      },
      { once: true }
    );
  });

  async function appendBuffer(buffer) {
    if (!sourceBuffer || done) return;
    await new Promise((resolve) => {
      sourceBuffer.addEventListener("updateend", resolve, { once: true });
      sourceBuffer.appendBuffer(buffer);
    });
  }

  async function play(stream) {
    await openPromise;
    audio.play();
    reader = stream.getReader();

    try {
      while (!done) {
        if (signal?.aborted) {
          break;
        }
        const { value, done: readerDone } = await reader.read();
        if (readerDone) {
          break;
        }
        if (value) {
          await appendBuffer(value);
        }
      }
    } finally {
      done = true;
      try {
        await reader?.cancel();
      } catch {
        // ignore
      }
      reader = null;

      if (mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream();
        } catch {
          // ignore
        }
      }
    }

    const endedPromise = new Promise((resolve) => {
      audio.addEventListener("ended", resolve, { once: true });
    });

    // Important: if we stop() (pause/reset) there may be no "ended" event.
    // So we also resolve on explicit stop.
    await Promise.race([endedPromise, stoppedPromise]);
  }

  function stop() {
    done = true;
    try {
      reader?.cancel();
    } catch {
      // ignore
    }
    audio.pause();
    audio.currentTime = 0;
    resolveStopped?.();
  }

  return { play, stop };
}

async function playElevenLabs(text, settings, abortSignal, player) {
  const { elevenlabsKey, elevenlabsVoice } = settings;
  if (!elevenlabsKey || !elevenlabsVoice) {
    throw new Error("Missing ElevenLabs settings");
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${elevenlabsVoice}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": elevenlabsKey,
        "content-type": "application/json",
        accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.6
        }
      }),
      signal: abortSignal
    }
  );

  if (!response.ok || !response.body) {
    let detail = "";
    try {
      const bodyText = await response.text();
      const snippet = bodyText && bodyText.length > 300 ? `${bodyText.slice(0, 300)}…` : bodyText;
      if (snippet) detail = ` - ${snippet}`;
    } catch {
      // ignore
    }
    throw new Error(`ElevenLabs request failed (status ${response.status})${detail}`);
  }

  return player.play(response.body);
}

export function createTtsController(settings) {
  let abortController = null;
  let activePlayer = null;

  async function speak(rawText) {
    const { control, text } = parseControlLine(rawText);
    const mergedSettings = {
      ...settings,
      ...(control || {})
    };
    if (!text) return;

    abortController = new AbortController();

    const provider = mergedSettings.ttsProvider || (mergedSettings.useElevenLabs ? "elevenlabs" : "default");

    if (provider === "elevenlabs") {
      activePlayer = createMediaSourcePlayer({ signal: abortController.signal });
      await playElevenLabs(text, mergedSettings, abortController.signal, activePlayer);
    } else {
      await playSpeechSynthesis(text, { lang: mergedSettings.sttLang });
    }
  }

  function stop() {
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (activePlayer) {
      activePlayer.stop();
      activePlayer = null;
    }
    if (speechSynthesis.speaking) {
      speechSynthesis.cancel();
    }
  }

  function updateSettings(nextSettings) {
    settings = nextSettings;
  }

  return { speak, stop, updateSettings };
}
