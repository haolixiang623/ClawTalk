export class VadDetector {
  constructor({ threshold, hangoverMs, minSpeechMs }) {
    this.threshold = threshold;
    this.hangoverMs = hangoverMs;
    this.minSpeechMs = minSpeechMs;
    this.isSpeaking = false;
    this.lastVoiceTs = 0;
    this.speechStartTs = 0;
  }

  processRms(rms, nowMs) {
    if (rms >= this.threshold) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.speechStartTs = nowMs;
      }
      this.lastVoiceTs = nowMs;
      return { event: "voice" };
    }

    if (this.isSpeaking) {
      const elapsedSinceVoice = nowMs - this.lastVoiceTs;
      const speechDuration = nowMs - this.speechStartTs;
      if (elapsedSinceVoice >= this.hangoverMs && speechDuration >= this.minSpeechMs) {
        this.isSpeaking = false;
        return { event: "speech_end" };
      }
    }

    return { event: "silence" };
  }
}

export function computeRms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const sample = buffer[i];
    sum += sample * sample;
  }
  return Math.sqrt(sum / buffer.length);
}
