// Hands a track's audio to the page in blocks, for the connector agent's transcription.
// Silence (a muted or missing input) is sent as zeros, so the speech gate still sees time pass.
const BLOCK = 2048;

class MoozPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    const frames = channel ? channel.length : 128;
    for (let i = 0; i < frames; i++) {
      this.block[this.filled++] = channel ? channel[i] : 0;
      if (this.filled === BLOCK) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("mooz-pcm", MoozPcm);
