// signaling.js
let socket;
export const connectSignaling = (onMessage) => {
  socket = new WebSocket("ws://localhost:8080/ws");
  socket.onmessage = (msg) => onMessage(JSON.parse(msg.data));
};

export const sendSignal = (data) => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
};
