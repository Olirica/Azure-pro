/**
 * PCM Audio Worklet Processor
 *
 * Captures audio from the microphone and converts it to 16-bit PCM
 * for streaming to server-side STT providers (Deepgram, Whisper, GPT-4o).
 *
 * Input: Float32 audio samples from AudioContext (usually 16kHz)
 * Output: Int16 PCM ArrayBuffer sent via postMessage
 */

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.bufferSize = 2048  // Samples per chunk (~128ms at 16kHz)
    this.buffer = new Float32Array(this.bufferSize)
    this.bufferIndex = 0
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    if (!input || !input[0]) return true

    const channelData = input[0]  // Mono channel

    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i]

      if (this.bufferIndex >= this.bufferSize) {
        // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
        const pcm16 = new Int16Array(this.bufferSize)
        for (let j = 0; j < this.bufferSize; j++) {
          const s = Math.max(-1, Math.min(1, this.buffer[j]))
          pcm16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF
        }

        // Send PCM buffer to main thread
        this.port.postMessage(pcm16.buffer, [pcm16.buffer])

        // Reset buffer
        this.buffer = new Float32Array(this.bufferSize)
        this.bufferIndex = 0
      }
    }

    return true  // Keep processor alive
  }
}

registerProcessor('pcm-processor', PcmProcessor)
