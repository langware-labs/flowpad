class FuncCommunicator {
  private callbacks: { [key: string]: (message: any) => void } = {};

  sendMessage(targetId: string, message: any) {
    const funcEvent = new CustomEvent(targetId, {
      detail: { message: message },
    });
    window.dispatchEvent(funcEvent);
  }

  listenForMessages(targetId: string, callback: (message: any) => void | Promise<void>) {
    if (this.callbacks[targetId]) {
      return;
    }

    const wrappedCallback = (event: any) => {
      // await if the callback returns a promise
      const result = callback(event.detail.message);
      if (result instanceof Promise) {
        result.catch(console.error);
      }
    };
    this.callbacks[targetId] = wrappedCallback;

    window.addEventListener(targetId, wrappedCallback);
  }

  stopListening(targetId: string) {
    window.removeEventListener(targetId, this.callbacks[targetId]);
    delete this.callbacks[targetId];
  }
}

export const funcCommunicator = new FuncCommunicator();

export default funcCommunicator;
