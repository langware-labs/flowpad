/* eslint-disable @typescript-eslint/no-unsafe-function-type */

export type RecorderEvents =
  | 'start'
  | 'stop'
  | 'record_progress'
  | 'playback_progress'
  | 'playback_status'
  | 'recording_status'
  | 'on_chunk';

export class BrowserRecorder {
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private logChunks: Blob[][] = [];
  private audioContext: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private startTime: number | null = null;
  private chunkIntervalMs: number = 1000; // Default 3 seconds
  private progressIntervalMs: number = 100; // Default 100ms for progress updates
  private progressTimer: number | null = null;
  //private codec: string = "audio/webm;codecs=opus"
  private codec: string = 'audio/webm';
  async startRecording() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    //this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType: this.codec,
      audioBitsPerSecond: 64000, // 64kbps (good for speech)
    });
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.source = this.audioContext.createMediaStreamSource(this.stream);
    this.mediaRecorder.ondataavailable = this.onAudioChunk.bind(this);
    this.mediaRecorder.onstop = () => {
      this.emit('recording_status', false);
      if (this.progressTimer !== null) {
        window.clearInterval(this.progressTimer);
        this.progressTimer = null;
      }
    };
    this.mediaRecorder.onstart = () => {
      this.emit('recording_status', true);
    };
    if (this.blobs.length > 0) {
      this.logChunks.push(this.blobs);
      this.audioChunks = [];
    }
    this.mediaRecorder.start(this.chunkIntervalMs);
    console.log('Recording started');
    console.log('Source:', this.source);
    this.startTime = Date.now();

    // Start progress reporting timer
    this.progressTimer = window.setInterval(() => {
      this.emit('record_progress', this.durationMs);
    }, this.progressIntervalMs);
  }

  get blobs() {
    return this.audioChunks;
  }

  async onAudioChunk(event: BlobEvent) {
    this.emit('on_chunk', event.data);
    this.audioChunks.push(event.data);
    // const reader = new FileReader();
    // reader.onload = () => {
    //   const arrayBuffer = reader.result as ArrayBuffer;
    //   console.log('Array buffer received', arrayBuffer);
    // };
  }

  get durationMs() {
    if (this.startTime) {
      const now = Date.now();
      return now - this.startTime;
    }
    return 0;
  }

  get isRecording(): boolean {
    if (!this.mediaRecorder || !this.stream) {
      return false;
    }
    const isMediaRecorderActive = this.mediaRecorder.state === 'recording';
    const isStreamActive = this.stream.getTracks().some((track) => track.readyState === 'live');
    return isMediaRecorderActive && isStreamActive;
  }

  get hasRecording(): boolean {
    return this.audioChunks.length > 0;
  }

  async play() {
    if (this.audioChunks.length > 0) {
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      // Listen for audio playing updates
      audio.ontimeupdate = () => {
        // Calculate current progress as a percentage
        const timeMs = audio.currentTime * 1000;
        const progress = (audio.currentTime / audio.duration) * 100;
        console.log(`Playback progress: ${progress}%`);
        this.emit('playback_progress', timeMs, progress);
      };

      audio.onended = () => {
        console.log('Playback complete');
        this.emit('playback_status', false); // Emitting the 'complete' event
      };
      audio.onplay = () => {
        console.log('Playback complete');
        this.emit('playback_status', true); // Emitting the 'complete' event
      };

      try {
        await audio.play();
      } catch (error) {
        console.error('Error playing the audio:', error);
      }
    } else {
      console.log('No audio to play');
    }
  }

  setChunkInterval(seconds: number) {
    if (seconds <= 0) {
      throw new Error('Chunk interval must be greater than 0 seconds');
    }
    this.chunkIntervalMs = seconds * 1000;
    // If currently recording, restart with new interval
    if (this.isRecording) {
      this.mediaRecorder?.stop();
      this.mediaRecorder?.start(this.chunkIntervalMs);
    }
  }

  setProgressInterval(milliseconds: number) {
    if (milliseconds <= 0) {
      throw new Error('Progress interval must be greater than 0 milliseconds');
    }
    this.progressIntervalMs = milliseconds;
    // If currently recording, restart the progress timer with new interval
    if (this.progressTimer !== null) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = window.setInterval(() => {
        this.emit('record_progress', this.durationMs);
      }, this.progressIntervalMs);
    }
  }

  async stopRecording() {
    if (this.progressTimer !== null) {
      window.clearInterval(this.progressTimer);
      this.progressTimer = null;
    }

    if (this.mediaRecorder) {
      this.mediaRecorder.stop();
    }

    // Stop the stream
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
    }
  }

  // Event emitter functionality (placeholder)
  private listeners: Record<string, Function[]> = {};

  on(event: RecorderEvents, listener: Function) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(listener);
  }

  emit(event: RecorderEvents, ...args: any[]) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((listener) => listener(...args));
    }
  }
}
