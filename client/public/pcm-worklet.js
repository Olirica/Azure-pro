/**
 * PCM Audio Worklet Processor
 *
 * Captures audio from microphone and converts to 16-bit PCM for streaming to server.
 * Used for server-side STT with Deepgram.
 *
 * Audio format: 16kHz, mono, 16-bit signed little-endian PCM
 */

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // Accumulate samples to send in larger chunks for efficiency
    this.buffer = new Float32Array(0)
    this.bufferSize = 2048  // ~128ms at 16kHz, good balance of latency vs overhead

    // Handle messages from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'config') {
        if (event.data.bufferSize) {
          this.bufferSize = event.data.bufferSize
        }
      }
    }
  }

  /**
   * Convert float32 audio samples to int16 PCM
   * @param {Float32Array} float32 - Input samples (-1.0 to 1.0)
   * @returns {Int16Array} - Output samples (-32768 to 32767)
   */
  float32ToInt16(float32) {
    const int16 = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
      // Clamp to [-1, 1] and convert to int16 range
      const s = Math.max(-1, Math.min(1, float32[i]))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
    }
    return int16
  }

  /**
   * Process audio samples
   * Called by the audio worklet runtime ~every 2.67ms (128 samples at 48kHz)
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0]
    if (!input || !input[0]) {
      return true  // Keep processor alive
    }

    // Get mono channel (first channel)
    const mono = input[0]

    // Append to buffer
    const newBuffer = new Float32Array(this.buffer.length + mono.length)
    newBuffer.set(this.buffer)
    newBuffer.set(mono, this.buffer.length)
    this.buffer = newBuffer

    // When buffer is full, send it
    if (this.buffer.length >= this.bufferSize) {
      // Convert to int16 PCM
      const int16 = this.float32ToInt16(this.buffer)

      // Transfer the buffer to main thread
      this.port.postMessage(int16.buffer, [int16.buffer])

      // Reset buffer
      this.buffer = new Float32Array(0)
    }

    return true  // Keep processor alive
  }
}

registerProcessor('pcm-processor', PcmProcessor)
