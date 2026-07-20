(() => {
  if (window.mirin) return;

  const port = __PORT__;
  const token = "__TOKEN__";
  const webview = __WEBVIEW__;
  let socket = null;
  let ready = false;
  let nextId = 1;
  let reconnectTimer = null;
  const queue = [];
  const pending = new Map();
  const listeners = new Map();

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 500);
  }

  function rejectPending(message) {
    const error = new Error(message);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    queue.length = 0;
  }

  function disconnect(disconnectedSocket, message = "rpc disconnected") {
    if (socket !== disconnectedSocket) return;
    socket = null;
    ready = false;
    rejectPending(message);
    scheduleReconnect();
  }

  function connect() {
    const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}&webview=${webview}`;
    let nextSocket;
    try {
      nextSocket = new WebSocket(url);
    } catch {
      rejectPending("rpc connect failed");
      scheduleReconnect();
      return;
    }

    socket = nextSocket;
    nextSocket.onopen = () => {
      if (socket !== nextSocket) return;
      ready = true;
      const waiting = queue.splice(0, queue.length);
      for (const frame of waiting) {
        try {
          nextSocket.send(frame);
        } catch {
          disconnect(nextSocket);
          try {
            nextSocket.close();
          } catch {}
          return;
        }
      }
    };
    nextSocket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.kind === "response") {
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        if (message.ok) call.resolve(message.result);
        else call.reject(new Error(message.error || "rpc error"));
        return;
      }
      if (message.kind === "event") {
        for (const listener of listeners.get(message.method) ?? []) {
          try {
            listener(message.payload);
          } catch {}
        }
      }
    };
    nextSocket.onclose = () => disconnect(nextSocket);
    nextSocket.onerror = () => {
      disconnect(nextSocket, "rpc connection error");
      try {
        nextSocket.close();
      } catch {}
    };
  }

  function send(message) {
    const serialized = JSON.stringify(message);
    const currentSocket = socket;
    if (!ready || !currentSocket) {
      queue.push(serialized);
      return;
    }
    try {
      currentSocket.send(serialized);
    } catch {
      disconnect(currentSocket);
      try {
        currentSocket.close();
      } catch {}
    }
  }

  window.mirin = {
    webviewId: webview,
    call(method, input) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ kind: "request", id, method, input });
      });
    },
    onEvent(method, listener) {
      const methodListeners = listeners.get(method) ?? [];
      methodListeners.push(listener);
      listeners.set(method, methodListeners);
      return () => {
        const current = listeners.get(method) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
    control(action, extra) {
      send({ kind: "control", action, ...(extra ?? {}) });
    },
  };

  // The webview consumes title-bar input. Forward left-mousedown coordinates so
  // native code can check CEF's authoritative `-webkit-app-region` regions and
  // start a window move or edge resize.
  try {
    const resizeBorder = 6;
    const resizeCursors = {
      10: "ew-resize",
      11: "ew-resize",
      12: "ns-resize",
      13: "nwse-resize",
      14: "nesw-resize",
      15: "ns-resize",
      16: "nesw-resize",
      17: "nwse-resize",
    };
    let hasCursor = false;
    const edgeHitTest = (event) => {
      const left = event.clientX <= resizeBorder;
      const right = event.clientX >= window.innerWidth - resizeBorder;
      const top = event.clientY <= resizeBorder;
      const bottom = event.clientY >= window.innerHeight - resizeBorder;
      if (top && left) return 13;
      if (top && right) return 14;
      if (bottom && left) return 16;
      if (bottom && right) return 17;
      if (left) return 10;
      if (right) return 11;
      if (top) return 12;
      if (bottom) return 15;
      return 0;
    };

    document.addEventListener(
      "mousemove",
      (event) => {
        const hitTest = edgeHitTest(event);
        if (hitTest) {
          document.documentElement.style.cursor = resizeCursors[hitTest];
          hasCursor = true;
        } else if (hasCursor) {
          document.documentElement.style.cursor = "";
          hasCursor = false;
        }
      },
      true,
    );
    document.addEventListener(
      "mousedown",
      (event) => {
        if (event.button !== 0) return;
        send({
          kind: "control",
          action: "window.maybeStartDrag",
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
          detail: event.detail,
          ht: edgeHitTest(event),
        });
      },
      true,
    );
  } catch {}

  connect();
})();
