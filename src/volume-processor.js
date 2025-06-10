// public/volume-processor.js
class HighQualityVolumeProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._lastUpdate = currentTime;
    this._volume = 0;
    this._sampleRate = options.processorOptions?.sampleRate || 48000;
    this._bufferSize = 4096; // 更大的缓冲区提高处理质量
    this._sampleBuffer = new Float32Array(this._bufferSize);
    this._bufferIndex = 0;
  }

  calculateVolume(samples) {
    // 使用更精确的RMS计算
    let sum = 0;
    let peak = 0;
    let zeroCrossings = 0;
    
    for (let i = 0; i < samples.length; ++i) {
      const sample = samples[i];
      sum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
      
      // 零交叉检测
      if (i > 0 && samples[i-1] * sample < 0) {
        zeroCrossings++;
      }
    }
    
    const rms = Math.sqrt(sum / samples.length);
    const dynamicRange = peak > 0 ? 20 * Math.log10(peak / rms) : 0;
    
    return { 
      rms, 
      peak,
      zeroCrossings,
      dynamicRange
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    
    // 高质量音频直通
    if (input && input[0] && output && output[0]) {
      for (let channel = 0; channel < output.length; ++channel) {
        output[channel].set(input[channel]);
      }
    }
    
    // 定期发送高级音频分析数据
    if (currentTime > this._lastUpdate + 0.1) {
      if (input && input[0]) {
        const audioData = input[0];
        const volumeInfo = this.calculateVolume(audioData);
        this.port.postMessage(volumeInfo);
      }
      this._lastUpdate = currentTime;
    }
    
    return true;
  }
}

registerProcessor('volume-processor', HighQualityVolumeProcessor);