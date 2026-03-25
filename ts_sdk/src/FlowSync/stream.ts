import { EventEmitter } from 'events';
import { TranscriptMessage } from '../websocket';

export interface IStreamConfig {
  data_type: string;
}

export const WSStreamTestConfig = {
  data_type: 'TEST_FAST',
};

export interface IStream {
  id: number;
  config?: IStreamConfig;
}

export type WSStreamEvent = 'ON_MESSAGE' | 'ON_BIN_MESSAGE' | 'ON_SEND' | 'ON_CLOSE';

export class WSStream extends EventEmitter implements IStream {
  id: number;

  constructor(istream: IStream) {
    super();
    if (!istream || !istream.id) {
      throw new Error('Invalid stream constructor');
    }
    this.id = istream.id;
  }

  async handleMessage(msg: TranscriptMessage) {
    this.emit('ON_MESSAGE', msg);
  }

  async handleBinMessage(blob: Uint8Array) {
    this.emit('ON_BIN_MESSAGE', blob);
  }

  async send(data: Blob) {
    if (this.id === undefined) {
      throw new Error('Stream ID is not set');
    }
    this.emit('ON_SEND', data);
  }
  async close() {
    if (this.id === undefined) {
      throw new Error('Stream ID is not set, can not close');
    }
    this.emit('ON_CLOSE');
  }
}
